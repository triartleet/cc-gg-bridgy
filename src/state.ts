import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A provider is either the reserved "anthropic" (no env injection) or the
// basename of a ~/.config/gephyra/<name>.env profile. Names are restricted to
// the charset the shell shim accepts from state.json.
export type Provider = string;

export const ANTHROPIC: Provider = "anthropic";
const NAME_RE = /^[A-Za-z0-9_-]+$/;

// The config directory was named after this extension's former id. An install
// that predates the rename keeps its provider profiles — and therefore its API
// keys — in the old directory, so resolve to whichever exists: the new one wins,
// the old one is used while it is the only one present. Nothing is copied or
// moved: the credentials are the user's, and silently relocating files that hold
// keys is not this extension's call to make.
const LEGACY_DIR_NAME = "cc-gg-bridgy";
const DIR_NAME = "gephyra";

function resolveStateDir(): string {
  const configRoot = path.join(os.homedir(), ".config");
  const current = path.join(configRoot, DIR_NAME);
  const legacy = path.join(configRoot, LEGACY_DIR_NAME);
  try {
    if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
  } catch {
    /* fall through to the current path */
  }
  return current;
}

export interface GephyraState {
  projects: Record<string, Provider>;
  default: Provider;
  // Folded in from a former standalone vision-proxy.url file: the localhost URL
  // the vision-proxy host writes so the shim (which already reads state.json)
  // can route through it. Absent ⇒ proxy off/unreachable (fail-open).
  visionProxyUrl?: string;
}

export const stateDir = resolveStateDir();
export const stateFile = path.join(stateDir, "state.json");

export const envFileFor = (provider: Provider): string =>
  path.join(stateDir, `${provider}.env`);

// Anthropic plus every <name>.env profile, Anthropic first then alphabetical —
// the discovery order is also the toggle/QuickPick order.
export function listProviders(): Provider[] {
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(stateDir)
      .filter((f) => f.endsWith(".env"))
      .map((f) => f.slice(0, -4))
      .filter((n) => NAME_RE.test(n) && n !== ANTHROPIC)
      .sort();
  } catch {
    /* no config dir yet */
  }
  return [ANTHROPIC, ...names];
}

const DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Claude",
  glm: "GLM",
  kimi: "Kimi",
};

export const displayName = (provider: Provider): string =>
  DISPLAY_NAMES[provider] ??
  provider.charAt(0).toUpperCase() + provider.slice(1);

// One-letter code for the inline status readout ("C 12% · G 34% · K 8%").
export const letterFor = (provider: Provider): string =>
  provider === ANTHROPIC ? "C" : displayName(provider).charAt(0).toUpperCase();

// The shim compares keys against `pwd -P`, so keys must be physical paths.
export function canonical(projectPath: string): string {
  try {
    return fs.realpathSync(projectPath);
  } catch {
    return projectPath;
  }
}

const validName = (p: unknown): p is Provider =>
  typeof p === "string" && NAME_RE.test(p);

export function readState(): GephyraState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const projects: Record<string, Provider> = {};
    for (const [k, v] of Object.entries(raw.projects ?? {})) {
      if (validName(v)) projects[k] = v;
    }
    return {
      projects,
      default: validName(raw.default) ? raw.default : ANTHROPIC,
      ...(typeof raw.visionProxyUrl === "string" && raw.visionProxyUrl
        ? { visionProxyUrl: raw.visionProxyUrl }
        : {}),
    };
  } catch {
    return { projects: {}, default: ANTHROPIC };
  }
}

// Mirrors the shim exactly: a profile whose env file is missing injects
// nothing, so the session would really run on Anthropic — report that truth
// rather than the stored name.
export function providerFor(projectPath: string): Provider {
  const s = readState();
  const stored = s.projects[canonical(projectPath)] ?? s.default;
  if (stored === ANTHROPIC) return ANTHROPIC;
  return fs.existsSync(envFileFor(stored)) ? stored : ANTHROPIC;
}

// Unique temp name per write: two windows toggling concurrently must never
// rename each other's temp away; pretty-printed output is part of the shim's
// parse contract (one "key": "value" pair per line).
//
// Race-safety: we read the file right before writing, not at toggle start,
// so two windows toggling different projects won't clobber each other — each
// sees and preserves the other's write. Last writer wins only when both toggle
// the SAME project concurrently (acceptable user error).
export function setProvider(projectPath: string, provider: Provider): void {
  const key = canonical(projectPath);
  fs.mkdirSync(stateDir, { recursive: true });

  // Read current state as late as possible to see concurrent writes
  let s: GephyraState;
  try {
    s = readState();
  } catch {
    s = { projects: {}, default: ANTHROPIC };
  }

  s.projects[key] = provider;

  const tmp = `${stateFile}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, stateFile);
}

// The vision-proxy host writes its localhost URL here (folded in from a former
// standalone vision-proxy.url file) so the shim — which already reads
// state.json — can route through it. Same read-late/atomic-rename discipline as
// setProvider; null removes the field (proxy off/unreachable ⇒ shim fail-opens
// to direct provider injection).
export function setVisionProxyUrl(url: string | null): void {
  fs.mkdirSync(stateDir, { recursive: true });

  let s: GephyraState;
  try {
    s = readState();
  } catch {
    s = { projects: {}, default: ANTHROPIC };
  }

  if (url) s.visionProxyUrl = url;
  else delete s.visionProxyUrl;

  const tmp = `${stateFile}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, stateFile);
}
