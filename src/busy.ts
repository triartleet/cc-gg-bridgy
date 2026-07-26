import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export type SessionActivity = "idle" | "busy" | "no-session"

// Nothing written for this long = the session is dead, whatever the tail says.
const STALE_MS = 30 * 60 * 1000

// Claude Code's project-slug rule: every non-alphanumeric character becomes "-".
export function projectSlug(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-")
}

export function sessionDirFor(projectPath: string): string {
  return path.join(os.homedir(), ".claude", "projects", projectSlug(projectPath))
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ~/.claude/sessions/<pid>.json is Claude Code's live-session registry
// (identity only, no status field) — the authoritative way to find WHICH
// session serves this project, instead of guessing by newest mtime.
function liveSessionIds(projectPath: string): string[] {
  const dir = path.join(os.homedir(), ".claude", "sessions")
  const ids: string[] = []
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return ids
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))
      if (rec.cwd === projectPath && rec.sessionId && pidAlive(rec.pid)) ids.push(rec.sessionId)
    } catch {
      continue
    }
  }
  return ids
}

// Subagent/workflow activity lands in nested per-session directories, not the
// top-level transcript — a busy signal must include them.
function newestMtimeUnder(root: string, depth: number): number {
  if (depth < 0) return 0
  let newest = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      newest = Math.max(newest, newestMtimeUnder(full, depth - 1))
    } else if (e.name.endsWith(".jsonl")) {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs)
      } catch {
        /* raced deletion */
      }
    }
  }
  return newest
}

function newestTopLevelTranscript(dir: string): { file: string; mtimeMs: number } | null {
  let best: { file: string; mtimeMs: number } | null = null
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue
    const full = path.join(dir, name)
    try {
      const st = fs.statSync(full)
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs))
        best = { file: full, mtimeMs: st.mtimeMs }
    } catch {
      continue
    }
  }
  return best
}

// User-record tails that await no response: interrupts, slash-command echo,
// background-task notices. A genuine prompt or tool_result stays "open".
function userTailAwaitsResponse(content: unknown): boolean {
  if (typeof content === "string") {
    return !(
      content.startsWith("[Request interrupted by user") ||
      content.includes("<local-command-stdout>") ||
      content.includes("<command-name>") ||
      content.startsWith("<task-notification>")
    )
  }
  return true
}

// Widen the tail window until it holds a parseable substantive record — a
// single transcript line can exceed 1.8 MB, and an all-fragments window must
// fail toward busy, never idle.
function tailImpliesOpenTurn(file: string): boolean {
  let fd: number
  try {
    fd = fs.openSync(file, "r")
  } catch {
    return false
  }
  try {
    const size = fs.fstatSync(fd).size
    let span = Math.min(size, 256 * 1024)
    for (;;) {
      const buf = Buffer.alloc(span)
      fs.readSync(fd, buf, 0, span, size - span)
      const lines = buf.toString("utf8").split("\n").filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        let rec: any
        try {
          rec = JSON.parse(lines[i])
        } catch {
          continue
        }
        if (rec.isSidechain) continue
        if (rec.type === "user") return userTailAwaitsResponse(rec.message?.content)
        if (rec.type === "assistant") {
          const stop = rec.message?.stop_reason
          return !(stop === "end_turn" || stop === "stop_sequence" || stop === "refusal")
        }
      }
      if (span >= size) return false
      span = Math.min(size, span * 4)
    }
  } catch {
    return true
  } finally {
    fs.closeSync(fd)
  }
}

export interface ActiveSession {
  sessionId: string
  file: string
  // True when the live-session registry says a running process still holds
  // this id — resuming it elsewhere makes two writers on one transcript.
  live: boolean
  newestActivityMs: number
}

export function resolveActiveSession(projectPath: string): ActiveSession | null {
  const dir = sessionDirFor(projectPath)
  const live = liveSessionIds(projectPath)

  let picked: { id: string; file: string; mtimeMs: number } | null = null
  let newestActivity = 0
  if (live.length > 0) {
    for (const id of live) {
      const file = path.join(dir, `${id}.jsonl`)
      try {
        const st = fs.statSync(file)
        if (!picked || st.mtimeMs > picked.mtimeMs) picked = { id, file, mtimeMs: st.mtimeMs }
      } catch {
        continue
      }
      newestActivity = Math.max(newestActivity, newestMtimeUnder(path.join(dir, id), 5))
    }
  }
  if (!picked) {
    const t = newestTopLevelTranscript(dir)
    if (t) {
      const id = path.basename(t.file, ".jsonl")
      picked = { id, file: t.file, mtimeMs: t.mtimeMs }
      newestActivity = newestMtimeUnder(path.join(dir, id), 5)
    }
  }
  if (!picked) return null

  return {
    sessionId: picked.id,
    file: picked.file,
    live: live.includes(picked.id),
    newestActivityMs: Math.max(newestActivity, picked.mtimeMs),
  }
}

export function classify(projectPath: string, quietWindowMs: number): SessionActivity {
  const session = resolveActiveSession(projectPath)
  if (!session) return "no-session"

  const age = Date.now() - session.newestActivityMs
  if (age < quietWindowMs) return "busy"
  if (age > STALE_MS) return "idle"
  return tailImpliesOpenTurn(session.file) ? "busy" : "idle"
}
