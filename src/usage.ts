import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  ANTHROPIC,
  envFileFor,
  listProviders,
  Provider,
  stateDir,
} from "./state";

// Usage is polled per discovered provider: Anthropic from the statusline tee,
// env profiles through an adapter picked by their base URL's hostname. Gephyra
// renders whatever it gets and NEVER blocks on it — any failure shows "—".
export interface WindowUsage {
  pct: number;
  resetMs: number | null;
}

export interface ProviderUsage {
  fiveHour: WindowUsage | null;
  weekly: WindowUsage | null;
  note?: string;
  error?: string;
  // True when the numbers come from a feed that can lag far behind real use.
  // Today only the Anthropic statusline tee (terminal-only) sets this; the
  // renderer must never pass a stale snapshot off as live, nor tint the bar
  // warning-red on one.
  stale?: boolean;
  // Epoch-ms the underlying feed was last written — fuels an "how stale?"
  // age readout (Anthropic tee mtime). Undefined for live-fetched profiles.
  asOfMs?: number;
}

export interface UsageSnapshot {
  providers: Record<Provider, ProviderUsage | null>;
  fetchedAt: number;
}

const FETCH_TIMEOUT_MS = 10_000;
const BACKOFF_MS = 15 * 60 * 1000;
// The statusline feed only updates while a terminal session turns over —
// beyond this age the numbers get an "as of" note instead of reading current.
const FEED_FRESH_MS = 30 * 60 * 1000;

// Live Anthropic usage (opt-in). Claude Code stores its OAuth credential in the
// macOS Keychain under this service, account `claude-code-user`, as a JSON blob
// {claudeAiOauth:{accessToken,expiresAt,...}}. Gephyra is a READ-ONLY consumer
// of that credential: it uses the access token the CLI already maintains and
// NEVER refreshes it. Refreshing would call the OAuth token endpoint, which
// rotates the refresh token — and since the credential belongs to the CLI (not
// gephyra), rotating it logs the CLI out. So gephyra reads, uses the token if
// unexpired, and otherwise falls back to the tee; it never touches auth state.
// Response field names (/api/oauth/usage) verified live: top-level five_hour/
// seven_day carrying a `utilization` percent and an ISO-8601 `resets_at`.
const KEYCHAIN_SERVICE = "Claude Code-credentials";
// The CLI's canonical keychain account. Targeting it (not an unqualified read)
// means gephyra uses the SAME user the CLI does, even if a stray second entry
// (e.g. left behind by a previous login) is present under the same service.
const CLAUDE_ACCOUNT = "claude-code-user";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_TIMEOUT_MS = 8000;
// Don't use a token within this skew of expiry — it could lapse mid-request.
const TOKEN_SKEW_MS = 60_000;
const execFileP = promisify(execFile);
// Terse opt-in diagnostics: fetchAnthropicUsageLive (and its helpers) only run
// when gephyra.anthropicLiveUsage is on, so these logs are auto-gated to
// that opt-in. FAILURE-only — never log on success, or it spams every poll.
const dbg = (...a: unknown[]): void =>
  console.warn("[gephyra:anthropic-live]", ...a);

const nextAllowed: Record<Provider, number> = {};
let snapshot: UsageSnapshot = { providers: {}, fetchedAt: 0 };

export function currentUsage(): UsageSnapshot {
  return snapshot;
}

function readFileMaybe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

const unavailable = (error: string): ProviderUsage => ({
  fiveHour: null,
  weekly: null,
  error,
});

// Parse one usage window from either feed. The statusline tee sends
// {used_percentage, resets_at:<unix seconds>}; the live OAuth endpoint sends
// {utilization, resets_at:<ISO-8601 string>}. Accept both so one parser serves
// both paths.
function usageWindow(w: any): WindowUsage | null {
  if (!w || typeof w !== "object") return null;
  const pct =
    typeof w.utilization === "number"
      ? w.utilization
      : typeof w.used_percentage === "number"
        ? w.used_percentage
        : null;
  return pct === null ? null : { pct, resetMs: parseResetMs(w.resets_at) };
}

function parseResetMs(v: unknown): number | null {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000; // ms vs unix seconds
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// The Anthropic numbers come from Claude Code's OWN statusline payload
// (rate_limits, present once a session has made a real turn), teed to a file
// by the user's statusline script. Chosen over the community OAuth usage
// endpoint because the Keychain access-token copy can already be expired
// between CLI renewals, and refreshing it ourselves would touch auth flows —
// a locked non-goal. Trade-off: only TERMINAL sessions run the statusline
// script, so the feed's freshness rides on terminal use.
function fetchAnthropicUsage(): ProviderUsage {
  // Resolved via stateDir so this reads the SAME directory the provider
  // registry does — a hardcoded path here can split from the legacy-dir
  // fallback and silently freeze the readout on an old snapshot.
  const file = path.join(stateDir, "statusline-last.json");
  const raw = readFileMaybe(file);
  if (!raw)
    return unavailable("no statusline feed yet — run a terminal claude turn");
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    /* keep 0 */
  }
  let rl: any;
  try {
    rl = JSON.parse(raw)?.rate_limits;
  } catch {
    return unavailable("statusline feed unparseable");
  }
  const fiveHour = usageWindow(rl?.five_hour);
  const weekly = usageWindow(rl?.seven_day);
  if (!fiveHour && !weekly)
    return unavailable(
      "statusline feed has no rate_limits yet — run a terminal claude turn",
    );
  // The statusline runs only in terminal sessions, so the file can sit
  // unchanged for hours while panel conversations burn through the window.
  // Flag staleness (and carry the feed's mtime) so the readout shows the AGE
  // of the snapshot instead of silently freezing on one confident number.
  const stale = !mtimeMs || Date.now() - mtimeMs > FEED_FRESH_MS;
  return { fiveHour, weekly, stale, asOfMs: mtimeMs || undefined };
}

// Read Claude Code's stored OAuth credential from the macOS Keychain — the
// access token and its expiry, NOT the refresh token (gephyra never refreshes).
// Targets the CLI's canonical account first, then any entry under the service,
// so gephyra uses the same user the CLI does. Best-effort + bounded so a Keychain
// prompt can never stall the usage poll: any failure returns null and the caller
// falls back to the statusline tee. The secret stays in-process — never logged.
async function readClaudeCredentials(): Promise<{
  accessToken: string;
  expiresAt: number;
} | null> {
  for (const acct of [CLAUDE_ACCOUNT, null]) {
    const args = ["find-generic-password", "-s", KEYCHAIN_SERVICE];
    if (acct) args.push("-a", acct);
    args.push("-w");
    let stdout: string;
    try {
      const r = await execFileP("security", args, {
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: 1 << 20,
      });
      stdout = r.stdout;
    } catch {
      continue; // no entry for this account — try the unqualified fallback
    }
    try {
      const oauth = JSON.parse(stdout.trim())?.claudeAiOauth;
      if (
        typeof oauth?.accessToken === "string" &&
        typeof oauth?.expiresAt === "number"
      ) {
        return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
      }
    } catch {
      /* try the fallback account */
    }
  }
  dbg("no usable Claude Code credential in keychain");
  return null;
}

// Live Anthropic usage — read-only. Uses the access token the Claude Code CLI
// stores in the keychain and NEVER refreshes it (refreshing would rotate the
// CLI's token and log it out). Returns null on ANY miss so refreshUsage falls
// back to the (honest-staled) statusline tee — this path only ever makes the
// readout fresher, never worse.
async function fetchAnthropicUsageLive(): Promise<ProviderUsage | null> {
  const cred = await readClaudeCredentials();
  if (!cred) return null;
  // A momentarily-expired token isn't ours to renew — the CLI refreshes it on
  // its next turn. Skip this cycle and let the tee fill in.
  if (cred.expiresAt <= Date.now() + TOKEN_SKEW_MS) {
    dbg(
      "stored access token expired — deferring to the CLI's next refresh; tee this cycle",
    );
    return null;
  }
  let res: Response;
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${cred.accessToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    dbg(`usage GET failed: HTTP ${res.status}`);
    return null;
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    dbg("usage response unparseable");
    return null;
  }
  const rl = body?.rate_limits ?? body?.data?.rate_limits ?? body?.data ?? body;
  const fiveHour = usageWindow(rl?.five_hour);
  const weekly = usageWindow(rl?.seven_day);
  if (!fiveHour && !weekly) {
    dbg(
      "usage response had no five_hour/seven_day — top-level keys:",
      Object.keys(body ?? {}).join(","),
    );
    return null;
  }
  return { fiveHour, weekly, stale: false };
}

// Profiles are KEY=value lines (the shim's parse contract). The auth token
// may live in either var: z.ai documents ANTHROPIC_AUTH_TOKEN, Kimi Code
// documents ANTHROPIC_API_KEY — profiles commonly set both to the same key.
function parseProfileEnv(provider: Provider): {
  token: string | null;
  origin: string | null;
} {
  const raw = readFileMaybe(envFileFor(provider));
  let authToken: string | null = null;
  let apiKey: string | null = null;
  let origin: string | null = null;
  for (const line of raw?.split("\n") ?? []) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (m[1] === "ANTHROPIC_AUTH_TOKEN") authToken = m[2];
    if (m[1] === "ANTHROPIC_API_KEY") apiKey = m[2];
    if (m[1] === "ANTHROPIC_BASE_URL") {
      try {
        origin = new URL(m[2]).origin;
      } catch {
        /* keep null */
      }
    }
  }
  return { token: authToken ?? apiKey, origin };
}

// z.ai quota limits: TOKENS_LIMIT rows are the prompt/token windows (hour-unit
// row = the 5h cycle, the other = weekly); TIME_LIMIT is the monthly MCP-tools
// allotment, which gephyra doesn't render. Authorization is the bare key.
async function fetchZaiUsage(
  provider: Provider,
  origin: string,
  token: string,
): Promise<ProviderUsage> {
  const res = await fetch(`${origin}/api/monitor/usage/quota/limit`, {
    headers: { Authorization: token, "Accept-Language": "en-US,en" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 429) {
    nextAllowed[provider] = Date.now() + BACKOFF_MS;
    return unavailable("HTTP 429 — rate-limited, backing off 15 min");
  }
  if (!res.ok) return unavailable(`HTTP ${res.status}`);
  const body: any = await res.json();
  const limits: any[] = Array.isArray(body?.data?.limits)
    ? body.data.limits
    : [];
  const tokenWindows = limits
    .filter(
      (l) => l?.type === "TOKENS_LIMIT" && typeof l.percentage === "number",
    )
    .sort((a, b) => (a.nextResetTime ?? 0) - (b.nextResetTime ?? 0));
  const win = (l: any): WindowUsage | null =>
    l ? { pct: l.percentage, resetMs: l.nextResetTime ?? null } : null;
  const hourRow = tokenWindows.find((l) => l.unit === 3) ?? tokenWindows[0];
  const weekRow =
    tokenWindows.find((l) => l.unit === 6 && l !== hourRow) ??
    tokenWindows.find((l) => l !== hourRow);
  return {
    fiveHour: win(hourRow ?? null),
    weekly: win(weekRow ?? null),
    note: typeof body?.data?.level === "string" ? body.data.level : undefined,
  };
}

// ---- Kimi Code (api.kimi.com coding plan) ---------------------------------
// GET <origin>/coding/v1/usages, Authorization: Bearer <sk-kimi key>.
// UNVERIFIED against a live account: there is no official API reference for
// this endpoint, only community pollers, and two response shapes have been
// observed in the wild — an {usage, limits[]} object and a {data: [...]}
// array keyed by model_name with "all" as the summary row. Extraction is
// therefore defensive field-hunting: unknown shapes degrade to "usage
// unavailable", never throw.

const num = (v: any): number | null =>
  typeof v === "number" && isFinite(v) ? v : null;

function kimiPct(o: any): number | null {
  if (!o || typeof o !== "object") return null;
  const limit = num(o.limit) ?? num(o.limit_amount) ?? num(o.total);
  const used = num(o.used) ?? num(o.used_amount);
  const remaining = num(o.remaining) ?? num(o.remaining_amount);
  if (limit && limit > 0) {
    if (used !== null) return Math.min(100, (used / limit) * 100);
    if (remaining !== null)
      return Math.min(100, ((limit - remaining) / limit) * 100);
  }
  return num(o.percentage) ?? num(o.pct);
}

function kimiResetMs(o: any): number | null {
  if (!o || typeof o !== "object") return null;
  const abs = num(o.resetTime) ?? num(o.reset_at) ?? num(o.reset_time);
  // Epoch guess: >1e12 is ms, >1e9 is seconds; anything smaller is not an
  // absolute timestamp.
  if (abs !== null) return abs > 1e12 ? abs : abs > 1e9 ? abs * 1000 : null;
  const rel = num(o.reset_in);
  return rel !== null ? Date.now() + rel * 1000 : null;
}

function kimiWindowKind(l: any): "fiveHour" | "weekly" | null {
  const w = l?.window ?? l?.detail?.window ?? l;
  const unit = String(w?.timeUnit ?? w?.time_unit ?? "").toUpperCase();
  const dur = num(w?.duration);
  if ((unit === "HOUR" && dur === 5) || (unit === "MINUTE" && dur === 300))
    return "fiveHour";
  if ((unit === "DAY" && dur === 7) || unit === "WEEK") return "weekly";
  return null;
}

async function fetchKimiUsage(
  provider: Provider,
  origin: string,
  token: string,
): Promise<ProviderUsage> {
  const res = await fetch(`${origin}/coding/v1/usages`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 429) {
    nextAllowed[provider] = Date.now() + BACKOFF_MS;
    return unavailable("HTTP 429 — rate-limited, backing off 15 min");
  }
  if (!res.ok) return unavailable(`HTTP ${res.status}`);
  const body: any = await res.json();
  const root = Array.isArray(body?.data)
    ? (body.data.find((r: any) => r?.model_name === "all") ?? body.data[0])
    : (body?.data ?? body);
  const limits: any[] = Array.isArray(root?.limits)
    ? root.limits
    : Array.isArray(body?.limits)
      ? body.limits
      : [];
  let fiveHour: WindowUsage | null = null;
  let weekly: WindowUsage | null = null;
  for (const l of limits) {
    const kind = kimiWindowKind(l);
    if (!kind) continue;
    const src = l?.detail ?? l;
    const pct = kimiPct(src);
    if (pct === null) continue;
    const w = { pct, resetMs: kimiResetMs(src) ?? kimiResetMs(l) };
    if (kind === "fiveHour" && !fiveHour) fiveHour = w;
    else if (kind === "weekly" && !weekly) weekly = w;
  }
  // The plan's primary quota is weekly — when no explicit 7-day row exists,
  // read the overall usage object as that window.
  if (!weekly) {
    const overall = root?.usage ?? (Array.isArray(body?.data) ? root : null);
    const pct = kimiPct(overall);
    if (pct !== null) weekly = { pct, resetMs: kimiResetMs(overall) };
  }
  if (!fiveHour && !weekly)
    return unavailable("unrecognized usages response shape");
  const level = root?.level ?? body?.level ?? root?.membership_level;
  return {
    fiveHour,
    weekly,
    note: typeof level === "string" ? level : undefined,
  };
}

// Adapter registry, keyed by the profile's base-URL hostname so a profile can
// be named anything ("glm2" still gets the z.ai adapter). Unknown endpoints
// read as unavailable rather than guessing at a quota API.
async function fetchProfileUsage(provider: Provider): Promise<ProviderUsage> {
  const { token, origin } = parseProfileEnv(provider);
  if (!origin) return unavailable(`no ANTHROPIC_BASE_URL in ${provider}.env`);
  if (!token) return unavailable(`no auth token in ${provider}.env`);
  const host = new URL(origin).hostname;
  const matches = (domain: string): boolean =>
    host === domain || host.endsWith(`.${domain}`);
  if (matches("z.ai")) return fetchZaiUsage(provider, origin, token);
  if (matches("kimi.com")) return fetchKimiUsage(provider, origin, token);
  return unavailable("no usage adapter for this endpoint");
}

// A fresh error keeps the previous side's numbers (stale beats blank
// mid-session) but carries the reason so the tooltip can say WHY.
function merge(
  prev: ProviderUsage | null,
  fresh: ProviderUsage,
): ProviderUsage {
  if (fresh.fiveHour || fresh.weekly) return fresh;
  return prev ? { ...prev, error: fresh.error } : fresh;
}

export async function refreshUsage(
  opts: { liveAnthropic?: boolean } = {},
): Promise<UsageSnapshot> {
  const now = Date.now();
  const providers: Record<Provider, ProviderUsage | null> = {};
  await Promise.all(
    listProviders().map(async (p) => {
      const prev = snapshot.providers[p] ?? null;
      if (p === ANTHROPIC) {
        // Opt-in live read first; on any miss fall back to the statusline tee
        // (which carries an honest staleness flag). Live data is authoritative.
        if (opts.liveAnthropic) {
          try {
            const live = await fetchAnthropicUsageLive();
            if (live) {
              providers[p] = live;
              return;
            }
          } catch {
            /* fall through to the tee */
          }
        }
        let a: ProviderUsage;
        try {
          a = fetchAnthropicUsage();
        } catch (e: any) {
          a = unavailable(String(e?.message ?? e));
        }
        providers[p] = merge(prev, a);
      } else if (now < (nextAllowed[p] ?? 0)) {
        providers[p] = prev;
      } else {
        const u = await fetchProfileUsage(p).catch((e) =>
          unavailable(String(e?.message ?? e)),
        );
        providers[p] = merge(prev, u);
      }
    }),
  );
  snapshot = { providers, fetchedAt: now };
  return snapshot;
}

export function formatReset(resetMs: number | null): string {
  if (!resetMs) return "";
  const d = new Date(resetMs);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (resetMs - Date.now() < 24 * 60 * 60 * 1000) return hhmm;
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${hhmm}`;
}
