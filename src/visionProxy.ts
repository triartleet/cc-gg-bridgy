import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { envFileFor, setVisionProxyUrl, stateDir } from "./state";

// Vision proxy — an opt-in localhost reverse proxy that keeps a project on its
// chosen provider (GLM/Kimi/…) for text and code, but routes image-bearing
// message turns — and the tool-loops they start — to Anthropic pay-as-you-go,
// where vision actually works. This is a scoped, opt-in EXCEPTION to gephyra's
// "never proxy traffic" stance (DECISIONS.md records the decision); with it off,
// no traffic is proxied and the wrapper injects the provider env directly as
// always.
//
// Wiring: the wrapper, when a `visionProxyUrl` field is present in state.json
// for a non-anthropic provider, sets ANTHROPIC_BASE_URL=<that url>/<provider>.
// The provider name is the PATH PREFIX, so one shared proxy resolves the real
// upstream statelessly. ANTHROPIC_AUTH_TOKEN stays the provider's, so the CLI
// sends it and the proxy forwards it upstream verbatim; for the Anthropic leg
// the proxy swaps in the PAYG key and rewrites the model.

const VISION_ENV = path.join(stateDir, "anthropic-vision.env");
const LOG_FILE = path.join(stateDir, "vision-proxy.log");
const HEALTH_PATH = "/__ccgg_health__";
const HEALTH_MARKER = "gephyra-vision-proxy/1";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const SOFT_BODY_WARN = 64 * 1024 * 1024;
const GUEST_PROBE_MS = 3000;
const SHUTDOWN_GRACE_MS = 1500;
const DEFAULT_PORT = 4399;
const DEFAULT_VISION_MODEL = "claude-sonnet-5";
const LOG_CAP = 1_048_576;
const VISION_FAIL_THROTTLE_MS = 5 * 60 * 1000;

let server: http.Server | null = null;
let guestTimer: ReturnType<typeof setInterval> | null = null;
let configuredPort = 0;
let role: "off" | "host" | "guest" = "off";
const sockets = new Set<net.Socket>();
let warnedMissingEnv = false;
let lastVisionFailNotify = 0;

// --- profile parsing (same contract as beam.ts/usage.ts) ---------------------

function parseEnv(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function visionConfig(): { apiKey: string; model: string } | null {
  const e = parseEnv(VISION_ENV);
  const apiKey = e.ANTHROPIC_API_KEY ?? e.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) return null;
  // Model: the env-file override wins (back-compat / escape hatch), else the
  // user-level `gephyra.visionModel` setting (default claude-sonnet-5). The
  // KEY stays in the env file — settings.json is not a safe place for a secret.
  const envModel = e.GEPHYRA_VISION_MODEL ?? e.ANTHROPIC_MODEL;
  const model =
    envModel && envModel.trim()
      ? envModel
      : vscode.workspace
          .getConfiguration("gephyra")
          .get<string>("visionModel", DEFAULT_VISION_MODEL);
  return { apiKey, model };
}

function upstreamBase(provider: string): string | null {
  const base = parseEnv(envFileFor(provider)).ANTHROPIC_BASE_URL;
  return base ? base.replace(/\/+$/, "") : null;
}

// --- routing decision (pure, stateless) --------------------------------------
// Forward to Anthropic iff (a) the LAST user message carries an image block, or
// (b) the last message is a tool_result continuing a tool-loop that Claude
// started. Otherwise the turn goes to the upstream provider. This is what
// returns control to GLM the moment a normal text follow-up arrives: its last
// message is plain user text with no image and no tool_result → upstream.
function routeToAnthropic(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1] as {
    role?: string;
    content?: unknown;
  };
  if (last.role !== "user") return false;
  const blocks = Array.isArray(last.content)
    ? (last.content as Array<{ type?: string }>)
    : [];
  if (blocks.some((b) => b?.type === "image")) return true;
  if (blocks.some((b) => b?.type === "tool_result")) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: string; model?: string };
      if (m.role === "assistant")
        return typeof m.model === "string" && /^claude/i.test(m.model);
    }
  }
  return false;
}

// --- request path & body helpers --------------------------------------------

function parseProviderPath(
  reqUrl: string,
): { provider: string; target: string } | null {
  const q = reqUrl.indexOf("?");
  const pathname = q >= 0 ? reqUrl.slice(0, q) : reqUrl;
  const search = q >= 0 ? reqUrl.slice(q) : "";
  const parts = pathname.split("/").filter(Boolean); // ["glm","v1","messages"]
  if (parts.length < 1) return null;
  const provider = parts[0];
  if (!/^[A-Za-z0-9_-]+$/.test(provider)) return null;
  const target = "/" + parts.slice(1).join("/") + search; // "/v1/messages"
  return { provider, target };
}

function readBody(
  req: http.IncomingMessage,
  cb: (err: Error | null, body: Buffer | null) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let warned = false;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (!warned && size > SOFT_BODY_WARN) {
      warned = true;
      log("body exceeded soft cap (" + size + " bytes) — still forwarded");
    }
    chunks.push(c);
  });
  req.on("end", () => cb(null, Buffer.concat(chunks)));
  req.on("error", (e) => cb(e, null));
}

function cleanHeaders(inp: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const h: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(inp)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    // host/content-length/connection/transfer-encoding are hop-by-hop or
    // recomputed by Node for the upstream request.
    if (
      lk === "host" ||
      lk === "content-length" ||
      lk === "connection" ||
      lk === "transfer-encoding"
    )
      continue;
    h[lk] = v;
  }
  return h;
}

// Forward a buffered body to target, piping the upstream SSE/byte response
// straight back to the client. The AbortSignal is the load-bearing teardown
// primitive: when the client disconnects (req/res 'close' → controller.abort),
// the upstream call is destroyed too, so no connection is left dangling — and
// for the Anthropic leg, no PAYG stream keeps billing silently.
function forward(
  method: string,
  target: string,
  headers: http.OutgoingHttpHeaders,
  body: Buffer,
  res: http.ServerResponse,
  signal: AbortSignal,
  label: string,
): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    if (!res.headersSent) res.writeHead(502);
    try {
      res.end();
    } catch {
      /* client gone */
    }
    return;
  }
  const lib = url.protocol === "https:" ? https : http;
  headers["content-length"] = String(body.length);
  const up = lib.request(
    {
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      headers,
      signal,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("error", (err) => {
    if (signal.aborted) return; // client gone — expected, already torn down
    log(label + " upstream error: " + err);
    if (!res.headersSent)
      res.writeHead(502, { "content-type": "application/json" });
    try {
      if (!res.writableEnded)
        res.end(
          JSON.stringify({
            error: { type: "cc_gg_bridgy_proxy_error", message: String(err) },
          }),
        );
    } catch {
      /* client gone */
    }
  });
  up.end(body);
}

function forwardToUpstream(
  provider: string,
  target: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
  signal: AbortSignal,
): void {
  const base = upstreamBase(provider);
  if (!base) {
    if (!res.headersSent)
      res.writeHead(502, { "content-type": "application/json" });
    try {
      res.end(
        JSON.stringify({
          error: {
            type: "cc_gg_bridgy_proxy_error",
            message:
              "no ANTHROPIC_BASE_URL in " + provider + ".env — cannot route",
          },
        }),
      );
    } catch {
      /* client gone */
    }
    return;
  }
  forward(
    req.method ?? "POST",
    base + target,
    cleanHeaders(req.headers),
    body,
    res,
    signal,
    "upstream:" + provider,
  );
}

function visionFailureMessage(status: number): string {
  switch (status) {
    case 402:
      return "Anthropic vision credits exhausted — the pay-as-you-go key is out of balance. Top it up in ~/.config/gephyra/anthropic-vision.env, or turn off gephyra.visionProxy (image turns then fall back to the provider).";
    case 401:
    case 403:
      return "Anthropic vision leg rejected the pay-as-you-go key — check ANTHROPIC_API_KEY in ~/.config/gephyra/anthropic-vision.env, or turn off gephyra.visionProxy.";
    case 429:
      return "Anthropic vision leg is rate-limited — retry shortly, or turn off gephyra.visionProxy.";
    default:
      return "Anthropic vision leg failed (HTTP " + status + ").";
  }
}

// A spent PAYG key / bad key / rate-limit is surfaced as a throttled, actionable
// warning — not silent, and not a hard break: the image turn is failed OPEN to
// the upstream provider (so the user's flow continues; the image answer is then
// provider-served and flagged as unreliable), never a crash.
function notifyVisionFailure(status: number): void {
  const now = Date.now();
  if (now - lastVisionFailNotify < VISION_FAIL_THROTTLE_MS) return;
  lastVisionFailNotify = now;
  log(
    "vision leg HTTP " + status + " — failing image turn open to the provider",
  );
  void vscode.window
    .showWarningMessage(
      "Gephyra: " + visionFailureMessage(status),
      "Turn off vision proxy",
    )
    .then((pick) => {
      if (pick === "Turn off vision proxy")
        void vscode.workspace
          .getConfiguration("gephyra")
          .update("visionProxy", false, vscode.ConfigurationTarget.Global);
    });
}

// Anthropic vision leg: rewrite the model, swap in the PAYG key, forward. On a
// credits/auth/rate-limit response (or a network error reaching Anthropic),
// fail that turn open to the upstream provider and notify — graceful, never a
// hard break. The original body is kept so the failover uses the provider's own
// model and auth, not the rewritten Claude ones.
function forwardToAnthropic(
  provider: string,
  target: string,
  parsedBody: unknown,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  originalBody: Buffer,
  signal: AbortSignal,
  vc: { apiKey: string; model: string },
): void {
  (parsedBody as { model?: string }).model = vc.model;
  const newBody = Buffer.from(JSON.stringify(parsedBody), "utf8");
  const headers = cleanHeaders(req.headers);
  delete headers.authorization; // never send the provider token to Anthropic
  headers["x-api-key"] = vc.apiKey;
  headers["content-length"] = String(newBody.length);
  const failOpen = (): void =>
    forwardToUpstream(provider, target, req, res, originalBody, signal);
  const url = new URL(ANTHROPIC_MESSAGES_URL);
  const up = https.request(
    {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname,
      headers,
      signal,
    },
    (upRes) => {
      const status = upRes.statusCode ?? 0;
      if (
        status === 401 ||
        status === 402 ||
        status === 403 ||
        status === 429
      ) {
        upRes.resume(); // drain so the upstream socket frees
        notifyVisionFailure(status);
        failOpen();
        return;
      }
      res.writeHead(status, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("error", (err) => {
    if (signal.aborted) return; // client gone — expected
    log("anthropic upstream error: " + err + " — failing open to provider");
    failOpen();
  });
  up.end(newBody);
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    if (
      req.method === "GET" &&
      (req.url === HEALTH_PATH || req.url === HEALTH_PATH + "/")
    ) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(HEALTH_MARKER);
      return;
    }
    const parsed = parseProviderPath(req.url ?? "/");
    if (!parsed) {
      res.writeHead(404);
      res.end();
      return;
    }
    const { provider, target } = parsed;

    readBody(req, (err, body) => {
      if (err || body === null) {
        try {
          if (!res.writableEnded) res.end();
        } catch {
          /* client gone */
        }
        return;
      }
      // One AbortController per request owns the teardown of BOTH halves.
      const controller = new AbortController();
      const cleanup = (): void => controller.abort();
      req.on("close", cleanup);
      res.on("close", cleanup);

      const isMessages = req.method === "POST" && target === "/v1/messages";
      let parsedBody: unknown = null;
      if (isMessages) {
        try {
          parsedBody = JSON.parse(body.toString("utf8"));
        } catch {
          /* malformed → fail-open to upstream (don't crash the parser) */
        }
      }

      if (isMessages && parsedBody && routeToAnthropic(parsedBody)) {
        const vc = visionConfig();
        if (!vc) {
          // Vision creds missing mid-flight: fail-open to upstream (today's
          // broken-image behavior), never a crash.
          forwardToUpstream(
            provider,
            target,
            req,
            res,
            body,
            controller.signal,
          );
          return;
        }
        forwardToAnthropic(
          provider,
          target,
          parsedBody,
          req,
          res,
          body,
          controller.signal,
          vc,
        );
      } else {
        forwardToUpstream(provider, target, req, res, body, controller.signal);
      }
    });
  } catch (e) {
    log("handler error: " + e);
    try {
      if (!res.headersSent) res.writeHead(502);
      if (!res.writableEnded) res.end();
    } catch {
      /* client gone */
    }
  }
}

// --- lifecycle: bind-or-guest, with guest→host promotion ---------------------

function probeOurs(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: HEALTH_PATH,
        method: "GET",
        timeout: 1000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c.toString()));
        res.on("end", () => resolve(data === HEALTH_MARKER));
      },
    );
    r.on("error", () => resolve(false));
    r.on("timeout", () => {
      r.destroy();
      resolve(false);
    });
    r.end();
  });
}

function startHost(port: number): void {
  configuredPort = port;
  const s = http.createServer(handle);
  server = s;
  s.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });
  s.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE" && role === "off") {
      // Another process holds the port. If it's ours (another gephyra window),
      // run as guest and watch; if foreign, stay off and let the wrapper
      // fail-open to direct provider injection.
      void probeOurs(port).then((ours) => {
        if (ours) becomeGuest(port);
        else {
          log("port " + port + " held by a foreign process — staying off");
          server = null;
          role = "off";
        }
      });
    } else {
      log("server error: " + e);
      server = null;
      role = "off";
    }
  });
  s.listen(port, "127.0.0.1", () => {
    role = "host";
    setVisionProxyUrl("http://127.0.0.1:" + port);
    log("hosting on 127.0.0.1:" + port);
  });
}

function becomeGuest(port: number): void {
  role = "guest";
  configuredPort = port;
  server = null;
  log("another window hosts 127.0.0.1:" + port + " — guest mode, watching");
  if (guestTimer) clearInterval(guestTimer);
  guestTimer = setInterval(() => {
    void probeOurs(port).then((alive) => {
      if (!alive && role === "guest" && enabled() && visionConfig()) {
        log("host gone — promoting to host");
        stopInternal();
        startHost(port);
      }
    });
  }, GUEST_PROBE_MS);
}

// Teardown: stop the guest watcher; if host, stop accepting, destroy every
// in-flight socket (closeAllConnections + a grace destroy of stragglers) so
// the port frees immediately instead of waiting out keep-alive idles, and
// clear the visionProxyUrl key from state.json so new CLIs don't route at a
// dead proxy. Only the HOST touches that key; a guest shutting down leaves
// it for its host.
function stopInternal(): void {
  if (guestTimer) {
    clearInterval(guestTimer);
    guestTimer = null;
  }
  const s = server;
  if (s && role === "host") {
    try {
      s.close();
      s.closeAllConnections();
    } catch {
      /* closing */
    }
    const grace = setTimeout(() => {
      for (const sock of sockets) {
        try {
          sock.destroy();
        } catch {
          /* gone */
        }
      }
    }, SHUTDOWN_GRACE_MS);
    grace.unref();
    setVisionProxyUrl(null);
  }
  server = null;
  role = "off";
}

// --- public surface (called by extension.ts) --------------------------------

function enabled(): boolean {
  return vscode.workspace
    .getConfiguration("gephyra")
    .get<boolean>("visionProxy", false);
}

function portSetting(): number {
  return vscode.workspace
    .getConfiguration("gephyra")
    .get<number>("visionProxyPort", DEFAULT_PORT);
}

// Idempotent: start/stop/restart to match the current settings. Called on
// activate and whenever gephyra.* config changes.
export function syncVisionProxy(): void {
  const port = portSetting();
  if (!enabled()) {
    stopInternal();
    return;
  }
  const vc = visionConfig();
  if (!vc) {
    stopInternal();
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      void vscode.window.showWarningMessage(
        "Gephyra: vision proxy is on but ~/.config/gephyra/anthropic-vision.env is missing ANTHROPIC_API_KEY + GEPHYRA_VISION_MODEL. Add a pay-as-you-go Anthropic key there to enable vision on GLM/Kimi; until then the proxy stays off (Claude Code runs direct).",
      );
    }
    return;
  }
  warnedMissingEnv = false;
  if (role !== "off" && port === configuredPort) return; // already serving in some role
  stopInternal();
  startHost(port);
}

export function disposeVisionProxy(): void {
  stopInternal();
}

function log(msg: string): void {
  try {
    try {
      if (fs.statSync(LOG_FILE).size > LOG_CAP) fs.writeFileSync(LOG_FILE, "");
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + " " + msg + "\n");
  } catch {
    /* best effort */
  }
}
