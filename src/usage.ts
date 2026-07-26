import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFile } from "node:child_process"

// Both providers expose official read-only usage endpoints; bridgy renders
// them side by side and NEVER blocks on them — any failure shows "—".
export interface WindowUsage {
  pct: number
  resetMs: number | null
}

export interface ProviderUsage {
  fiveHour: WindowUsage | null
  weekly: WindowUsage | null
  note?: string
}

export interface UsageSnapshot {
  anthropic: ProviderUsage | null
  glm: ProviderUsage | null
  fetchedAt: number
}

const FETCH_TIMEOUT_MS = 10_000
// The Anthropic endpoint is known to 429 persistently at times — back off
// rather than hammering it on the poll cadence.
const BACKOFF_MS = 15 * 60 * 1000

const nextAllowed: Record<"anthropic" | "glm", number> = { anthropic: 0, glm: 0 }
let snapshot: UsageSnapshot = { anthropic: null, glm: null, fetchedAt: 0 }

export function currentUsage(): UsageSnapshot {
  return snapshot
}

function readFileMaybe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

// Claude Code keeps its OAuth blob in ~/.claude/.credentials.json, or in the
// macOS Keychain under "Claude Code-credentials" (same JSON). Read-only; the
// token is used for one GET and never stored.
async function anthropicAccessToken(): Promise<string | null> {
  const raw = readFileMaybe(path.join(os.homedir(), ".claude", ".credentials.json"))
  const fromJson = (s: string): string | null => {
    try {
      return JSON.parse(s)?.claudeAiOauth?.accessToken ?? null
    } catch {
      return null
    }
  }
  if (raw) {
    const t = fromJson(raw)
    if (t) return t
  }
  if (process.platform !== "darwin") return null
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: FETCH_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : fromJson(stdout.trim())),
    )
  })
}

async function fetchAnthropicUsage(): Promise<ProviderUsage | null> {
  const token = await anthropicAccessToken()
  if (!token) return null
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 429) {
    nextAllowed.anthropic = Date.now() + BACKOFF_MS
    return null
  }
  if (!res.ok) return null
  const body: any = await res.json()
  const win = (w: any): WindowUsage | null =>
    typeof w?.utilization === "number"
      ? { pct: w.utilization, resetMs: w.resets_at ? Date.parse(w.resets_at) : null }
      : null
  return { fiveHour: win(body.five_hour), weekly: win(body.seven_day) }
}

function parseGlmEnv(): { token: string | null; origin: string } {
  const raw = readFileMaybe(path.join(os.homedir(), ".config", "cc-gg-bridgy", "glm.env"))
  let token: string | null = null
  let origin = "https://api.z.ai"
  for (const line of raw?.split("\n") ?? []) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/)
    if (!m) continue
    if (m[1] === "ANTHROPIC_AUTH_TOKEN") token = m[2]
    if (m[1] === "ANTHROPIC_BASE_URL") {
      try {
        origin = new URL(m[2]).origin
      } catch {
        /* keep default */
      }
    }
  }
  return { token, origin }
}

// z.ai quota limits: TOKENS_LIMIT rows are the prompt/token windows (hour-unit
// row = the 5h cycle, the other = weekly); TIME_LIMIT is the monthly MCP-tools
// allotment, which bridgy doesn't render. Authorization is the bare key.
async function fetchGlmUsage(): Promise<ProviderUsage | null> {
  const { token, origin } = parseGlmEnv()
  if (!token) return null
  const res = await fetch(`${origin}/api/monitor/usage/quota/limit`, {
    headers: { Authorization: token, "Accept-Language": "en-US,en" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 429) {
    nextAllowed.glm = Date.now() + BACKOFF_MS
    return null
  }
  if (!res.ok) return null
  const body: any = await res.json()
  const limits: any[] = Array.isArray(body?.data?.limits) ? body.data.limits : []
  const tokenWindows = limits
    .filter((l) => l?.type === "TOKENS_LIMIT" && typeof l.percentage === "number")
    .sort((a, b) => (a.nextResetTime ?? 0) - (b.nextResetTime ?? 0))
  const win = (l: any): WindowUsage | null =>
    l ? { pct: l.percentage, resetMs: l.nextResetTime ?? null } : null
  const hourRow = tokenWindows.find((l) => l.unit === 3) ?? tokenWindows[0]
  const weekRow = tokenWindows.find((l) => l.unit === 6 && l !== hourRow) ??
    tokenWindows.find((l) => l !== hourRow)
  return {
    fiveHour: win(hourRow ?? null),
    weekly: win(weekRow ?? null),
    note: typeof body?.data?.level === "string" ? body.data.level : undefined,
  }
}

// Refresh both sides concurrently; a failure keeps the previous side's data
// (stale beats blank mid-session) and never throws into the caller.
export async function refreshUsage(): Promise<UsageSnapshot> {
  const now = Date.now()
  const [a, g] = await Promise.all([
    now < nextAllowed.anthropic
      ? Promise.resolve(snapshot.anthropic)
      : fetchAnthropicUsage().catch(() => snapshot.anthropic),
    now < nextAllowed.glm
      ? Promise.resolve(snapshot.glm)
      : fetchGlmUsage().catch(() => snapshot.glm),
  ])
  snapshot = { anthropic: a ?? snapshot.anthropic, glm: g ?? snapshot.glm, fetchedAt: now }
  return snapshot
}

export function formatReset(resetMs: number | null): string {
  if (!resetMs) return ""
  const d = new Date(resetMs)
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  if (resetMs - Date.now() < 24 * 60 * 60 * 1000) return hhmm
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${hhmm}`
}
