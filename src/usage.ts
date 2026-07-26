import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

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
  error?: string
}

export interface UsageSnapshot {
  anthropic: ProviderUsage | null
  glm: ProviderUsage | null
  fetchedAt: number
}

const FETCH_TIMEOUT_MS = 10_000
const BACKOFF_MS = 15 * 60 * 1000
// The statusline feed only updates while a terminal session turns over —
// beyond this age the numbers get an "as of" note instead of reading current.
const FEED_FRESH_MS = 30 * 60 * 1000

const nextAllowed: Record<"glm", number> = { glm: 0 }
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

const unavailable = (error: string): ProviderUsage => ({ fiveHour: null, weekly: null, error })

// The Anthropic numbers come from Claude Code's OWN statusline payload
// (rate_limits, present once a session has made a real turn), teed to a file
// by ~/.claude/statusline-command.sh. Chosen over the community OAuth usage
// endpoint because the Keychain access-token copy rots on this machine
// (verified 401, token expired) and refreshing it ourselves would touch auth
// flows — a locked non-goal. Trade-off: only TERMINAL sessions run the
// statusline script, so the feed's freshness rides on terminal use.
function fetchAnthropicUsage(): ProviderUsage {
  const file = path.join(os.homedir(), ".config", "cc-gg-bridgy", "statusline-last.json")
  const raw = readFileMaybe(file)
  if (!raw) return unavailable("no statusline feed yet — run a terminal claude turn")
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    /* keep 0 */
  }
  let rl: any
  try {
    rl = JSON.parse(raw)?.rate_limits
  } catch {
    return unavailable("statusline feed unparseable")
  }
  // resets_at is unix SECONDS in this payload, unlike the OAuth endpoint.
  const win = (w: any): WindowUsage | null =>
    typeof w?.used_percentage === "number"
      ? { pct: w.used_percentage, resetMs: w.resets_at ? w.resets_at * 1000 : null }
      : null
  const fiveHour = win(rl?.five_hour)
  const weekly = win(rl?.seven_day)
  if (!fiveHour && !weekly)
    return unavailable("statusline feed has no rate_limits yet — run a terminal claude turn")
  const stale = mtimeMs && Date.now() - mtimeMs > FEED_FRESH_MS
  return {
    fiveHour,
    weekly,
    note: stale ? `as of ${formatReset(mtimeMs)}` : undefined,
  }
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
async function fetchGlmUsage(): Promise<ProviderUsage> {
  const { token, origin } = parseGlmEnv()
  if (!token) return unavailable("no ANTHROPIC_AUTH_TOKEN in glm.env")
  const res = await fetch(`${origin}/api/monitor/usage/quota/limit`, {
    headers: { Authorization: token, "Accept-Language": "en-US,en" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 429) {
    nextAllowed.glm = Date.now() + BACKOFF_MS
    return unavailable("HTTP 429 — rate-limited, backing off 15 min")
  }
  if (!res.ok) return unavailable(`HTTP ${res.status}`)
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

// A fresh error keeps the previous side's numbers (stale beats blank
// mid-session) but carries the reason so the tooltip can say WHY.
function merge(prev: ProviderUsage | null, fresh: ProviderUsage): ProviderUsage {
  if (fresh.fiveHour || fresh.weekly) return fresh
  return prev ? { ...prev, error: fresh.error } : fresh
}

export async function refreshUsage(): Promise<UsageSnapshot> {
  const now = Date.now()
  let a: ProviderUsage
  try {
    a = fetchAnthropicUsage()
  } catch (e: any) {
    a = unavailable(String(e?.message ?? e))
  }
  const g =
    now < nextAllowed.glm
      ? snapshot.glm
      : await fetchGlmUsage().catch((e) => unavailable(String(e?.message ?? e)))
  snapshot = {
    anthropic: merge(snapshot.anthropic, a),
    glm: g ? merge(snapshot.glm, g) : snapshot.glm,
    fetchedAt: now,
  }
  return snapshot
}

export function formatReset(resetMs: number | null): string {
  if (!resetMs) return ""
  const d = new Date(resetMs)
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  if (resetMs - Date.now() < 24 * 60 * 60 * 1000) return hhmm
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${hhmm}`
}
