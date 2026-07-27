import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// A provider is either the reserved "anthropic" (no env injection) or the
// basename of a ~/.config/cc-gg-bridgy/<name>.env profile. Names are
// restricted to the charset the shell shim accepts from state.json.
export type Provider = string

export const ANTHROPIC: Provider = "anthropic"
const NAME_RE = /^[A-Za-z0-9_-]+$/

export interface BridgyState {
  projects: Record<string, Provider>
  default: Provider
}

export const stateDir = path.join(os.homedir(), ".config", "cc-gg-bridgy")
export const stateFile = path.join(stateDir, "state.json")

export const envFileFor = (provider: Provider): string =>
  path.join(stateDir, `${provider}.env`)

// Anthropic plus every <name>.env profile, Anthropic first then alphabetical —
// the discovery order is also the toggle/QuickPick order.
export function listProviders(): Provider[] {
  let names: string[] = []
  try {
    names = fs
      .readdirSync(stateDir)
      .filter((f) => f.endsWith(".env"))
      .map((f) => f.slice(0, -4))
      .filter((n) => NAME_RE.test(n) && n !== ANTHROPIC)
      .sort()
  } catch {
    /* no config dir yet */
  }
  return [ANTHROPIC, ...names]
}

const DISPLAY_NAMES: Record<string, string> = { anthropic: "Claude", glm: "GLM", kimi: "Kimi" }

export const displayName = (provider: Provider): string =>
  DISPLAY_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)

// One-letter code for the inline status readout ("C 12% · G 34% · K 8%").
export const letterFor = (provider: Provider): string =>
  provider === ANTHROPIC ? "C" : displayName(provider).charAt(0).toUpperCase()

// The shim compares keys against `pwd -P`, so keys must be physical paths.
export function canonical(projectPath: string): string {
  try {
    return fs.realpathSync(projectPath)
  } catch {
    return projectPath
  }
}

const validName = (p: unknown): p is Provider => typeof p === "string" && NAME_RE.test(p)

export function readState(): BridgyState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"))
    const projects: Record<string, Provider> = {}
    for (const [k, v] of Object.entries(raw.projects ?? {})) {
      if (validName(v)) projects[k] = v
    }
    return {
      projects,
      default: validName(raw.default) ? raw.default : ANTHROPIC,
    }
  } catch {
    return { projects: {}, default: ANTHROPIC }
  }
}

// Mirrors the shim exactly: a profile whose env file is missing injects
// nothing, so the session would really run on Anthropic — report that truth
// rather than the stored name.
export function providerFor(projectPath: string): Provider {
  const s = readState()
  const stored = s.projects[canonical(projectPath)] ?? s.default
  if (stored === ANTHROPIC) return ANTHROPIC
  return fs.existsSync(envFileFor(stored)) ? stored : ANTHROPIC
}

// Unique temp name per write: two windows toggling concurrently must never
// rename each other's temp away; pretty-printed output is part of the shim's
// parse contract (one "key": "value" pair per line).
export function setProvider(projectPath: string, provider: Provider): void {
  const s = readState()
  s.projects[canonical(projectPath)] = provider
  fs.mkdirSync(stateDir, { recursive: true })
  const tmp = `${stateFile}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, stateFile)
}
