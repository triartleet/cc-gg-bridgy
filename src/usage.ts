import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { ANTHROPIC, envFileFor, listProviders, Provider } from "./state"

// Usage is polled per discovered provider: Anthropic from the statusline tee,
// env profiles through an adapter picked by their base URL's hostname. Bridgy
// renders whatever it gets and NEVER blocks on it — any failure shows "—".
export interface WindowUsage {
  pct: number
  resetMs: number | null
}

export interface ProviderUsage {
  fiveHour: WindowUsage | null
  weekly: WindowUsage | null
  note?: string
  error?: string
  // True when the numbers come from a feed that can lag far behind real use.
  // Today only the Anthropic statusline tee (terminal-only) sets this; the
  // renderer must never pass a stale snapshot off as live, nor tint the bar
  // warning-red on one.
  stale?: boolean
  // Epoch-ms the underlying feed was last written — fuels an "how stale?"
  // age readout (Anthropic tee mtime). Undefined for live-fetched profiles.
  asOfMs?: number
}

export interface UsageSnapshot {
  providers: Record<Provider, ProviderUsage | null>
  fetchedAt: number
}

const FETCH_TIMEOUT_MS = 10_000
const BACKOFF_MS = 15 * 60 * 1000
// The statusline feed only updates while a terminal session turns over —
// beyond this age the numbers get an "as of" note instead of reading current.
const FEED_FRESH_MS = 30 * 60 * 1000

// Live Anthropic usage (opt-in). Claude Code stores its OAuth credentials in
// the macOS Keychain under this service as a JSON blob {claudeAiOauth:{...}}.
// The persisted access token is usually EXPIRED (Claude Code refreshes in
// memory), so we refresh it ourselves — safe because the refresh_token is
// reusable, not rotated (Claude Code's own code consumes only access_token
// from the response and never stores a new refresh_token, yet stays logged in
// across days of refreshes). Recipe verified from the Claude Code 2.1.220
// bundle: token endpoint + client_id + the /api/oauth/usage field names, which
// match the statusline payload (five_hour/seven_day used_percentage/resets_at).
const KEYCHAIN_SERVICE = "Claude Code-credentials"
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const KEYCHAIN_TIMEOUT_MS = 8000
const TOKEN_SKEW_MS = 60_000
const execFileP = promisify(execFile)
// In-memory cache of a refreshed access token so we don't mint one every poll.
let claudeToken: { accessToken: string; expiresAt: number } | null = null
// Terse opt-in diagnostics: fetchAnthropicUsageLive (and its helpers) only run
// when ccGgBridgy.anthropicLiveUsage is on, so these logs are auto-gated to
// that opt-in. FAILURE-only — never log on success, or it spams every poll.
const dbg = (...a: unknown[]): void => console.warn("[cc-gg-bridgy:anthropic-live]", ...a)

const nextAllowed: Record<Provider, number> = {}
let snapshot: UsageSnapshot = { providers: {}, fetchedAt: 0 }
// Set when the OAuth refresh token is expired (invalid_grant) — the live path
// can't recover without an interactive login, so extension.ts surfaces a prompt.
let anthropicLoginNeeded = false
export function isAnthropicLoginNeeded(): boolean {
  return anthropicLoginNeeded
}

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
  // The statusline runs only in terminal sessions, so the file can sit
  // unchanged for hours while panel conversations burn through the window.
  // Flag staleness (and carry the feed's mtime) so the readout shows the AGE
  // of the snapshot instead of silently freezing on one confident number.
  const stale = !mtimeMs || Date.now() - mtimeMs > FEED_FRESH_MS
  return { fiveHour, weekly, stale, asOfMs: mtimeMs || undefined }
}

// Read Claude Code's stored OAuth credentials from the macOS Keychain. Best
// effort + bounded so a Keychain prompt can never stall the usage poll: any
// failure (denied, no item, unparseable) returns null and the caller falls
// back to the statusline tee. The secret stays in-process — never logged.
async function readClaudeCredentials(): Promise<{ refreshToken: string } | null> {
  let stdout: string
  try {
    const r = await execFileP(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 1 << 20 },
    )
    stdout = r.stdout
  } catch (e: any) {
    dbg("keychain read failed:", String(e?.message ?? e).slice(0, 120))
    return null
  }
  try {
    const oauth = JSON.parse(stdout.trim())?.claudeAiOauth
    if (typeof oauth?.refreshToken !== "string") {
      dbg("keychain blob has no claudeAiOauth.refreshToken")
      return null
    }
    return { refreshToken: oauth.refreshToken }
  } catch {
    dbg("keychain blob unparseable")
    return null
  }
}

// Mint a fresh access token from the reusable refresh token. On any failure
// (network, 4xx, unexpected shape) returns null — the caller falls back. We
// do NOT persist the new token: Claude Code owns the credential store, and
// since the refresh_token isn't rotated, refreshing here can't log it out.
async function refreshClaudeToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: number } | null> {
  let res: Response
  try {
    res = await fetch(CLAUDE_TOKEN_URL, {
      method: "POST",
      // Mirror Claude Code's own refresh request: the token endpoint 400s
      // without the OAuth beta header (verified against the 2.1.220 bundle).
      headers: {
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "anthropic-sdk-typescript userOAuthProvider",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (e: any) {
    dbg("token refresh network error:", String(e?.message ?? e).slice(0, 120))
    return null
  }
  if (!res.ok) {
    let detail = ""
    try {
      detail = (await res.text()).slice(0, 200)
    } catch {
      /* keep empty */
    }
    // invalid_grant = the refresh token itself is expired; no amount of
    // retrying helps until an interactive login mints a new one.
    if (res.status === 400 && detail.includes("invalid_grant")) anthropicLoginNeeded = true
    dbg(`token refresh failed: HTTP ${res.status} ${detail}`)
    return null
  }
  let body: any
  try {
    body = await res.json()
  } catch {
    dbg("token refresh response unparseable")
    return null
  }
  if (typeof body?.access_token !== "string") {
    dbg("token refresh response has no access_token:", Object.keys(body ?? {}).join(","))
    return null
  }
  // A successful refresh means the refresh token is alive again.
  anthropicLoginNeeded = false
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600
  return { accessToken: body.access_token, expiresAt: Date.now() + expiresIn * 1000 }
}

// Live Anthropic usage via the OAuth-refreshed token. Returns null on ANY miss
// so refreshUsage falls back to the (honest-staled) statusline tee — this path
// never makes the readout worse, only fresher when it succeeds. The response
// uses the same rate_limits shape as the statusline payload.
async function fetchAnthropicUsageLive(): Promise<ProviderUsage | null> {
  const cred = await readClaudeCredentials()
  if (!cred) return null
  if (!claudeToken || claudeToken.expiresAt <= Date.now() + TOKEN_SKEW_MS) {
    const t = await refreshClaudeToken(cred.refreshToken)
    if (!t) {
      claudeToken = null
      return null
    }
    claudeToken = t
  }
  let res: Response
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${claudeToken.accessToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    return null
  }
  // 401 = our token didn't land (e.g. just-rotated server-side); drop the cache
  // so the next poll re-refreshes, and fall back now.
  if (res.status === 401) {
    dbg("usage GET 401 — dropping cached token, will re-refresh next poll")
    claudeToken = null
    return null
  }
  if (!res.ok) {
    dbg(`usage GET failed: HTTP ${res.status}`)
    return null
  }
  let body: any
  try {
    body = await res.json()
  } catch {
    dbg("usage response unparseable")
    return null
  }
  const rl = body?.rate_limits ?? body?.data?.rate_limits ?? body?.data ?? body
  const win = (w: any): WindowUsage | null =>
    typeof w?.used_percentage === "number"
      ? { pct: w.used_percentage, resetMs: w.resets_at ? w.resets_at * 1000 : null }
      : null
  const fiveHour = win(rl?.five_hour)
  const weekly = win(rl?.seven_day)
  if (!fiveHour && !weekly) {
    dbg("usage response had no five_hour/seven_day — top-level keys:", Object.keys(body ?? {}).join(","))
    return null
  }
  return { fiveHour, weekly, stale: false }
}

// Profiles are KEY=value lines (the shim's parse contract). The auth token
// may live in either var: z.ai documents ANTHROPIC_AUTH_TOKEN, Kimi Code
// documents ANTHROPIC_API_KEY — profiles commonly set both to the same key.
function parseProfileEnv(provider: Provider): { token: string | null; origin: string | null } {
  const raw = readFileMaybe(envFileFor(provider))
  let authToken: string | null = null
  let apiKey: string | null = null
  let origin: string | null = null
  for (const line of raw?.split("\n") ?? []) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m) continue
    if (m[1] === "ANTHROPIC_AUTH_TOKEN") authToken = m[2]
    if (m[1] === "ANTHROPIC_API_KEY") apiKey = m[2]
    if (m[1] === "ANTHROPIC_BASE_URL") {
      try {
        origin = new URL(m[2]).origin
      } catch {
        /* keep null */
      }
    }
  }
  return { token: authToken ?? apiKey, origin }
}

// z.ai quota limits: TOKENS_LIMIT rows are the prompt/token windows (hour-unit
// row = the 5h cycle, the other = weekly); TIME_LIMIT is the monthly MCP-tools
// allotment, which bridgy doesn't render. Authorization is the bare key.
async function fetchZaiUsage(provider: Provider, origin: string, token: string): Promise<ProviderUsage> {
  const res = await fetch(`${origin}/api/monitor/usage/quota/limit`, {
    headers: { Authorization: token, "Accept-Language": "en-US,en" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 429) {
    nextAllowed[provider] = Date.now() + BACKOFF_MS
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

// ---- Kimi Code (api.kimi.com coding plan) ---------------------------------
// GET <origin>/coding/v1/usages, Authorization: Bearer <sk-kimi key>.
// UNVERIFIED against a live account: there is no official API reference for
// this endpoint, only community pollers, and two response shapes have been
// observed in the wild — an {usage, limits[]} object and a {data: [...]}
// array keyed by model_name with "all" as the summary row. Extraction is
// therefore defensive field-hunting: unknown shapes degrade to "usage
// unavailable", never throw.

const num = (v: any): number | null => (typeof v === "number" && isFinite(v) ? v : null)

function kimiPct(o: any): number | null {
  if (!o || typeof o !== "object") return null
  const limit = num(o.limit) ?? num(o.limit_amount) ?? num(o.total)
  const used = num(o.used) ?? num(o.used_amount)
  const remaining = num(o.remaining) ?? num(o.remaining_amount)
  if (limit && limit > 0) {
    if (used !== null) return Math.min(100, (used / limit) * 100)
    if (remaining !== null) return Math.min(100, ((limit - remaining) / limit) * 100)
  }
  return num(o.percentage) ?? num(o.pct)
}

function kimiResetMs(o: any): number | null {
  if (!o || typeof o !== "object") return null
  const abs = num(o.resetTime) ?? num(o.reset_at) ?? num(o.reset_time)
  // Epoch guess: >1e12 is ms, >1e9 is seconds; anything smaller is not an
  // absolute timestamp.
  if (abs !== null) return abs > 1e12 ? abs : abs > 1e9 ? abs * 1000 : null
  const rel = num(o.reset_in)
  return rel !== null ? Date.now() + rel * 1000 : null
}

function kimiWindowKind(l: any): "fiveHour" | "weekly" | null {
  const w = l?.window ?? l?.detail?.window ?? l
  const unit = String(w?.timeUnit ?? w?.time_unit ?? "").toUpperCase()
  const dur = num(w?.duration)
  if ((unit === "HOUR" && dur === 5) || (unit === "MINUTE" && dur === 300)) return "fiveHour"
  if ((unit === "DAY" && dur === 7) || unit === "WEEK") return "weekly"
  return null
}

async function fetchKimiUsage(provider: Provider, origin: string, token: string): Promise<ProviderUsage> {
  const res = await fetch(`${origin}/coding/v1/usages`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 429) {
    nextAllowed[provider] = Date.now() + BACKOFF_MS
    return unavailable("HTTP 429 — rate-limited, backing off 15 min")
  }
  if (!res.ok) return unavailable(`HTTP ${res.status}`)
  const body: any = await res.json()
  const root = Array.isArray(body?.data)
    ? body.data.find((r: any) => r?.model_name === "all") ?? body.data[0]
    : body?.data ?? body
  const limits: any[] = Array.isArray(root?.limits)
    ? root.limits
    : Array.isArray(body?.limits)
      ? body.limits
      : []
  let fiveHour: WindowUsage | null = null
  let weekly: WindowUsage | null = null
  for (const l of limits) {
    const kind = kimiWindowKind(l)
    if (!kind) continue
    const src = l?.detail ?? l
    const pct = kimiPct(src)
    if (pct === null) continue
    const w = { pct, resetMs: kimiResetMs(src) ?? kimiResetMs(l) }
    if (kind === "fiveHour" && !fiveHour) fiveHour = w
    else if (kind === "weekly" && !weekly) weekly = w
  }
  // The plan's primary quota is weekly — when no explicit 7-day row exists,
  // read the overall usage object as that window.
  if (!weekly) {
    const overall = root?.usage ?? (Array.isArray(body?.data) ? root : null)
    const pct = kimiPct(overall)
    if (pct !== null) weekly = { pct, resetMs: kimiResetMs(overall) }
  }
  if (!fiveHour && !weekly) return unavailable("unrecognized usages response shape")
  const level = root?.level ?? body?.level ?? root?.membership_level
  return { fiveHour, weekly, note: typeof level === "string" ? level : undefined }
}

// Adapter registry, keyed by the profile's base-URL hostname so a profile can
// be named anything ("glm2" still gets the z.ai adapter). Unknown endpoints
// read as unavailable rather than guessing at a quota API.
async function fetchProfileUsage(provider: Provider): Promise<ProviderUsage> {
  const { token, origin } = parseProfileEnv(provider)
  if (!origin) return unavailable(`no ANTHROPIC_BASE_URL in ${provider}.env`)
  if (!token) return unavailable(`no auth token in ${provider}.env`)
  const host = new URL(origin).hostname
  const matches = (domain: string): boolean => host === domain || host.endsWith(`.${domain}`)
  if (matches("z.ai")) return fetchZaiUsage(provider, origin, token)
  if (matches("kimi.com")) return fetchKimiUsage(provider, origin, token)
  return unavailable("no usage adapter for this endpoint")
}

// A fresh error keeps the previous side's numbers (stale beats blank
// mid-session) but carries the reason so the tooltip can say WHY.
function merge(prev: ProviderUsage | null, fresh: ProviderUsage): ProviderUsage {
  if (fresh.fiveHour || fresh.weekly) return fresh
  return prev ? { ...prev, error: fresh.error } : fresh
}

export async function refreshUsage(opts: { liveAnthropic?: boolean } = {}): Promise<UsageSnapshot> {
  const now = Date.now()
  const providers: Record<Provider, ProviderUsage | null> = {}
  await Promise.all(
    listProviders().map(async (p) => {
      const prev = snapshot.providers[p] ?? null
      if (p === ANTHROPIC) {
        // Opt-in live read first; on any miss fall back to the statusline tee
        // (which carries an honest staleness flag). Live data is authoritative.
        if (opts.liveAnthropic) {
          try {
            const live = await fetchAnthropicUsageLive()
            if (live) {
              providers[p] = live
              return
            }
          } catch {
            /* fall through to the tee */
          }
        }
        let a: ProviderUsage
        try {
          a = fetchAnthropicUsage()
        } catch (e: any) {
          a = unavailable(String(e?.message ?? e))
        }
        providers[p] = merge(prev, a)
      } else if (now < (nextAllowed[p] ?? 0)) {
        providers[p] = prev
      } else {
        const u = await fetchProfileUsage(p).catch((e) => unavailable(String(e?.message ?? e)))
        providers[p] = merge(prev, u)
      }
    }),
  )
  snapshot = { providers, fetchedAt: now }
  return snapshot
}

export function formatReset(resetMs: number | null): string {
  if (!resetMs) return ""
  const d = new Date(resetMs)
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  if (resetMs - Date.now() < 24 * 60 * 60 * 1000) return hhmm
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${hhmm}`
}
