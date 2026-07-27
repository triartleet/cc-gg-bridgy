import * as vscode from "vscode"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { beam } from "./beam"
import {
  classify,
  lastAssistantModel,
  registeredSessionPidsFor,
  registeredSessions,
  resumableSession,
  SessionActivity,
  sessionActivityFor,
} from "./busy"
import {
  activeBoundSessionId,
  boundClaudeTabs,
  drainTabBindings,
  initTabTracker,
  isClaudePanel,
} from "./tabs"
import {
  ANTHROPIC,
  canonical,
  displayName,
  envFileFor,
  letterFor,
  listProviders,
  Provider,
  providerFor,
  setProvider,
  stateDir,
} from "./state"
import { currentUsage, formatReset, ProviderUsage, refreshUsage } from "./usage"

const POLL_MS = 2000
const USAGE_POLL_MS = 5 * 60 * 1000
const USAGE_WARN_PCT = 80

let statusItem: vscode.StatusBarItem
let pollTimer: ReturnType<typeof setInterval> | undefined
let usageTimer: ReturnType<typeof setInterval> | undefined

function workspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

function quietWindowMs(): number {
  return vscode.workspace.getConfiguration("ccGgBridgy").get<number>("quietWindowMs", 2500)
}

function usageLine(name: string, u: ProviderUsage | null, weeklyLabel: string): string {
  if (!u || (!u.fiveHour && !u.weekly))
    return `**${name}** — usage unavailable${u?.error ? ` (${u.error})` : ""}`
  const part = (label: string, w: { pct: number; resetMs: number | null } | null): string =>
    w ? `${label} ${Math.round(w.pct)}%${w.resetMs ? ` (↻ ${formatReset(w.resetMs)})` : ""}` : ""
  const tier = u.note ? ` _(${u.note})_` : ""
  return [`**${name}**${tier}`, part("5h", u.fiveHour), part(weeklyLabel, u.weekly)]
    .filter(Boolean)
    .join(" · ")
}

// The toggle says what NEW conversations get; the focused tab's transcript
// says what it is actually serving — when they disagree, the status bar
// must say so instead of misreporting the tab.
function activeTabProvider(ws: string): Provider | null {
  const sid = activeBoundSessionId()
  if (!sid) return null
  const model = lastAssistantModel(ws, sid)
  if (!model) return null
  for (const p of listProviders()) {
    if (p === ANTHROPIC) continue
    try {
      const raw = fs.readFileSync(envFileFor(p), "utf8")
      for (const line of raw.split("\n")) {
        const m = line.match(/^[A-Z0-9_]*_MODEL[A-Z0-9_]*=(.*)$/)
        if (m && m[1].trim() === model) return p
      }
    } catch {
      /* unreadable profile — skip */
    }
  }
  return /^claude/i.test(model) ? ANTHROPIC : null
}

function render(ws: string, provider: Provider, activity: SessionActivity): void {
  const label = displayName(provider)
  const icon = activity === "busy" ? "$(sync~spin)" : "$(arrow-swap)"
  const usage = currentUsage()
  const providers = listProviders()
  const active = usage.providers[provider] ?? null
  const inline = providers.flatMap((p) => {
    const u = usage.providers[p]
    return u?.fiveHour ? [`${letterFor(p)} ${Math.round(u.fiveHour.pct)}%`] : []
  })
  const tabProvider = activeTabProvider(ws)
  statusItem.text = [
    `${icon} ${label}`,
    ...(tabProvider && tabProvider !== provider ? [`tab on ${displayName(tabProvider)}`] : []),
    ...inline,
  ].join(" · ")
  statusItem.tooltip = new vscode.MarkdownString(
    [
      `**CC-GG-bridgy** — next Claude Code session runs on **${label}**`,
      ...(tabProvider && tabProvider !== provider
        ? [
            "",
            `⚠ The focused tab's last turn was served by **${displayName(tabProvider)}** — it moves to ${label} when respawned or resumed.`,
          ]
        : []),
      "",
      ...providers.flatMap((p) => [
        usageLine(displayName(p), usage.providers[p] ?? null, p === ANTHROPIC ? "7d" : "wk"),
        "",
      ]),
      activity === "busy"
        ? "Session activity detected — switching is gated until the answer lands."
        : activity === "no-session"
          ? "No session transcript found for this workspace yet."
          : "Session idle — safe to switch.",
    ].join("\n"),
  )
  // The warning tint means "active provider's 5h window is nearly spent" —
  // provider identity stays text-only so the color can carry that one signal.
  statusItem.backgroundColor =
    active?.fiveHour && active.fiveHour.pct >= USAGE_WARN_PCT
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined
  statusItem.show()
}

function refresh(): void {
  const ws = workspacePath()
  if (!ws) {
    statusItem.hide()
    return
  }
  drainPendingKills(ws)
  drainTabBindings(ws)
  render(ws, providerFor(ws), classify(ws, quietWindowMs()))
}

// Exactly two providers → flip straight to the other one (the one-click flow
// from the binary era). Three or more → QuickPick with each provider's 5h %.
async function pickProvider(
  current: Provider,
  providers: Provider[],
): Promise<Provider | undefined> {
  if (providers.length === 2) return providers.find((p) => p !== current)
  const usage = currentUsage()
  const items = providers.map((p) => {
    const u = usage.providers[p]
    return {
      label: `${p === current ? "$(check) " : ""}${displayName(p)}`,
      description: u?.fiveHour ? `5h ${Math.round(u.fiveHour.pct)}%` : "usage —",
      provider: p,
    }
  })
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Provider for the next Claude Code conversation in this project",
  })
  return picked?.provider
}

// The Claude extension keeps ONE CLI process per window and reuses it across
// conversations, so a switched provider's env (and with it the /model tier
// labels) would only land after a window reload. Ending that process — our
// own child, since bridgy shares the extension host — forces the next
// conversation to respawn through the wrapper with the fresh profile env.
// Only ever matches the Claude extension's CLI under its install dir (or a
// resident copy of our shim), so language servers etc. are never touched.
// Ending a CLI process that backs an OPEN conversation view paints an
// "exited with code 143" error banner in that conversation, so those pids
// wait here instead; the 2s poll ends them the moment their conversation
// closes (no view attached — the kill is invisible). Unattached processes
// die immediately. The attached set MUST be filtered to this project's cwd,
// else any open session anywhere defers all kills.
const pendingKills = new Set<number>()

function restartClaudeCli(ws: string): void {
  execFile("pgrep", ["-P", String(process.pid), "-fl"], (err, stdout) => {
    if (err) return // no children, or pgrep unavailable — fail open
    const attached = registeredSessionPidsFor(ws)
    for (const line of stdout.split("\n")) {
      const m = line.match(/^(\d+)\s+(.*)$/)
      if (!m) continue
      if (!/anthropic\.claude-code-[^ ]*\/resources\/|cc-gg-wrapper/.test(m[2])) continue
      const pid = Number(m[1])
      if (attached.has(pid)) {
        pendingKills.add(pid)
        continue
      }
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        /* already gone */
      }
    }
  })
}

function drainPendingKills(ws: string): void {
  if (pendingKills.size === 0) return
  const attached = registeredSessionPidsFor(ws)
  for (const pid of [...pendingKills]) {
    try {
      process.kill(pid, 0)
    } catch {
      pendingKills.delete(pid) // exited on its own (clean close deregisters)
      continue
    }
    if (attached.has(pid)) continue // conversation still open — keep waiting
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* raced exit */
    }
    pendingKills.delete(pid)
  }
}

// The model picker mirrors the conversation process's env, so the ACTIVE
// panel only shows a switched provider after its process respawns — and
// killing it in place paints the exit-143 banner. Instead: close the panel
// (its CLI exits cleanly, no banner) and reopen the same session by id —
// `claude-vscode.primaryEditor.open` accepts a sessionId (verified in
// 2.1.220's URI handler; supersedes the decision-3-era "no resume-by-id
// command"), and a reopened panel spawns fresh through the wrapper under
// the new provider. Only when unambiguous: the focused tab IS a Claude
// panel AND this project has exactly ONE registered live conversation —
// the registry cannot say which session a given panel hosts, so with
// several a reopen could hijack the tab with the wrong one.
// Respawn every BOUND panel onto the just-switched provider: close (clean
// exit — no banner) and reopen by session id, each in its original column
// via claude-vscode.editor.open(sessionId, prompt, viewColumn). A session
// that looks mid-turn is skipped — never chop an open response; it keeps
// its old provider until closed (the deferred-kill path). The focused panel
// goes LAST so focus ends where the user was. An unbound focused panel
// falls back to the exactly-one-live-conversation heuristic.
async function respawnBoundPanels(ws: string): Promise<void> {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
  const entries = boundClaudeTabs()
  if (activeTab && isClaudePanel(activeTab) && !entries.some((e) => e.tab === activeTab)) {
    const wsKey = canonical(ws)
    const mine = [...registeredSessions().values()].filter(
      (s) => s.entrypoint === "claude-vscode" && canonical(s.cwd) === wsKey,
    )
    if (mine.length === 1) entries.push({ tab: activeTab, sessionId: mine[0].sessionId })
  }
  // Capture columns AND in-group indices before any close — closing
  // renumbers groups, and reopens append to a group's end, so reopening in
  // original (column, index) order is what reproduces the original order.
  const jobs = entries.map(({ tab, sessionId }) => ({
    tab,
    sessionId,
    column: tab.group.viewColumn,
    index: tab.group.tabs.indexOf(tab),
  }))
  const activeSessionId = entries.find((e) => e.tab === activeTab)?.sessionId
  // Three phases — close all, wait for all exits, reopen all — so the tab
  // row rebuilds ONCE instead of once per tab. A tab is only closed when
  // its bound session is idle AND resumable (has transcript content):
  // reopening a mis-bound id would replace a real conversation with a
  // blank Untitled panel — the lost-tab mode seen live.
  const closed: { sessionId: string; column: vscode.ViewColumn; index: number }[] = []
  for (const job of jobs) {
    const { sessionId, column, index } = job
    if (sessionActivityFor(ws, sessionId, quietWindowMs()) === "busy") continue
    if (!resumableSession(ws, sessionId)) continue
    // Re-resolve the tab at use time — earlier closes churn tab groups and
    // a stale snapshot makes close() throw, which used to vanish the tab.
    const tab = boundClaudeTabs().find((e) => e.sessionId === sessionId)?.tab ?? job.tab
    try {
      await vscode.window.tabGroups.close(tab)
      closed.push({ sessionId, column, index })
    } catch {
      /* close failed — the tab is still there, nothing lost */
    }
  }
  // The reopen must not race the close: the extension's createPanel
  // reveals (and throws on) the dying panel until its disposal is fully
  // processed. The registry entry outlives the panel by a beat — once it
  // is gone or its pid is dead, the close is definitely complete.
  await Promise.all(closed.map((c) => waitForSessionExit(c.sessionId)))
  // Reopen in original (column, index) order — appends reproduce the
  // original in-group order; focus is restored separately below.
  closed.sort((a, b) => a.column - b.column || a.index - b.index)
  // NOTE on ordering: VS Code inserts new tabs right of the ACTIVE tab, so
  // reopen order cannot control final positions, and post-hoc
  // moveActiveEditor placement (tried in 0.3.10) raced focus and moved the
  // WRONG editors — tabs got lost again. Mixed order is the accepted cost;
  // never trade tab integrity for cosmetics.
  for (const { sessionId, column } of closed) {
    if (!(await openSessionPanel(sessionId, column))) {
      await sleep(500)
      if (!(await openSessionPanel(sessionId, column)))
        void vscode.window.showWarningMessage(
          `CC-GG-bridgy: could not reopen conversation ${sessionId.slice(0, 8)}… — resume it from the session list.`,
        )
    }
  }
  // Reveal the previously focused conversation last: its panel now exists,
  // so this rides the extension's own reveal short-circuit — no creation.
  if (activeSessionId && closed.some((c) => c.sessionId === activeSessionId)) {
    const col = closed.find((c) => c.sessionId === activeSessionId)?.column
    if (col !== undefined) await openSessionPanel(activeSessionId, col)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitForSessionExit(sessionId: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const entry = [...registeredSessions().entries()].find(([, s]) => s.sessionId === sessionId)
    if (!entry) return
    try {
      process.kill(entry[0], 0)
    } catch {
      return // registry entry is stale — the process is already gone
    }
    await sleep(100)
  }
}

function claudePanelCount(): number {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isClaudePanel).length
}

async function openSessionPanel(sessionId: string, column: vscode.ViewColumn): Promise<boolean> {
  // An open can "succeed" as a silent no-op: the extension's session→panel
  // map can outlive the dead process by a beat, and createPanel then just
  // REVEALS the dying panel without throwing (the rare lost-tab mode that
  // survives every other guard). Only a panel that verifiably materialized
  // counts — anything else reports failure so the caller's delayed retry
  // runs after the disposal has certainly been processed.
  const before = claudePanelCount()
  try {
    await vscode.commands.executeCommand("claude-vscode.editor.open", sessionId, undefined, column)
  } catch {
    return false
  }
  for (let i = 0; i < 10; i++) {
    if (claudePanelCount() > before) return true
    await sleep(100)
  }
  return false
}

async function toggle(): Promise<void> {
  const ws = workspacePath()
  if (!ws) {
    void vscode.window.showWarningMessage("CC-GG-bridgy: open a workspace folder first.")
    return
  }
  const providers = listProviders()
  if (providers.length < 2) {
    void vscode.window.showWarningMessage(
      "CC-GG-bridgy: no provider profiles found — create ~/.config/cc-gg-bridgy/<name>.env (e.g. glm.env) first.",
    )
    return
  }
  const activity = classify(ws, quietWindowMs())
  if (activity === "busy") {
    const force = await vscode.window.showWarningMessage(
      "A Claude Code response may still be in flight. Switch anyway?",
      { modal: true },
      "Switch anyway",
    )
    if (force !== "Switch anyway") return
  }
  const current = providerFor(ws)
  const next = await pickProvider(current, providers)
  if (!next || next === current) return
  setProvider(ws, next)
  if (vscode.workspace.getConfiguration("ccGgBridgy").get<boolean>("restartCliOnSwitch", true)) {
    // Order matters: the kill sweep runs on a pre-close snapshot (attached
    // pids only get deferred, never killed in place), THEN the active panel
    // is closed and reopened — its fresh process spawns after the sweep, so
    // the sweep can never catch it.
    restartClaudeCli(ws)
    void respawnBoundPanels(ws)
  }
  void refreshUsage().then(refresh)
  refresh()
  // The toast teaches the handoff flow; regulars can silence it — the
  // status-bar label flipping is confirmation enough.
  if (!vscode.workspace.getConfiguration("ccGgBridgy").get<boolean>("switchToast", true)) return
  const picked = await vscode.window.showInformationMessage(
    `Now on ${displayName(next)} for ${path.basename(ws)}. Start a new conversation, then resume the previous session from the Claude panel's session list to continue it there.`,
    "New conversation",
    "Reload window",
  )
  if (picked === "New conversation")
    await vscode.commands.executeCommand("claude-vscode.newConversation")
  else if (picked === "Reload window")
    await vscode.commands.executeCommand("workbench.action.reloadWindow")
}

// The wrapper only works if the Claude extension launches its CLI through our
// shim. The setting points at a STABLE copy under ~/.config — an install-dir
// path would go stale on every bridgy update and break Claude Code's launch.
const stableWrapperPath = path.join(stateDir, "cc-gg-wrapper")

function installWrapperCopy(context: vscode.ExtensionContext): void {
  const bundled = context.asAbsolutePath(path.join("bin", "cc-gg-wrapper"))
  fs.mkdirSync(stateDir, { recursive: true })
  fs.copyFileSync(bundled, stableWrapperPath)
  fs.chmodSync(stableWrapperPath, 0o755)
}

async function setupWrapper(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("claudeCode")
  const current = cfg.get<string>("claudeProcessWrapper")
  if (current === stableWrapperPath) {
    installWrapperCopy(context)
    void vscode.window.showInformationMessage("CC-GG-bridgy: wrapper already configured (copy refreshed).")
    return
  }
  const answer = await vscode.window.showInformationMessage(
    current
      ? `claudeCode.claudeProcessWrapper is already set to "${current}". Replace it with the bridgy shim?`
      : "Point claudeCode.claudeProcessWrapper at the bridgy shim so provider switching can work?",
    { modal: true },
    "Configure",
  )
  if (answer !== "Configure") return
  installWrapperCopy(context)
  await cfg.update("claudeProcessWrapper", stableWrapperPath, vscode.ConfigurationTarget.Global)
  void vscode.window.showInformationMessage(
    "CC-GG-bridgy: wrapper configured. New Claude Code sessions will honor the toggle.",
  )
}

export function activate(context: vscode.ExtensionContext): void {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  statusItem.command = "cc-gg-bridgy.toggle"
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("cc-gg-bridgy.toggle", toggle),
  )
  initTabTracker(context)
  context.subscriptions.push(
    vscode.commands.registerCommand("cc-gg-bridgy.setupWrapper", () => setupWrapper(context)),
    vscode.commands.registerCommand("cc-gg-bridgy.beam", () => {
      const ws = workspacePath()
      if (!ws) {
        void vscode.window.showWarningMessage("CC-GG-bridgy: open a workspace folder first.")
        return
      }
      void beam(ws, quietWindowMs())
    }),
  )
  pollTimer = setInterval(refresh, POLL_MS)
  usageTimer = setInterval(() => void refreshUsage().then(refresh), USAGE_POLL_MS)
  context.subscriptions.push({
    dispose: () => {
      if (pollTimer) clearInterval(pollTimer)
      if (usageTimer) clearInterval(usageTimer)
    },
  })
  refresh()
  void refreshUsage().then(refresh)

  const current = vscode.workspace
    .getConfiguration("claudeCode")
    .get<string>("claudeProcessWrapper")
  if (current === stableWrapperPath) {
    // Self-heal: keep the stable copy in sync with this build of the shim,
    // and recreate it if the config dir was wiped.
    try {
      installWrapperCopy(context)
    } catch (e) {
      void vscode.window.showErrorMessage(`CC-GG-bridgy: cannot refresh wrapper copy: ${e}`)
    }
  } else if (!current || current.includes("cc-gg-wrapper")) {
    // Unset, or pointing at a stale bridgy install dir from before the stable
    // location existed — offer the (re)configure flow.
    void vscode.window
      .showInformationMessage(
        current
          ? "CC-GG-bridgy: the configured wrapper path is stale — reconfigure to the stable location."
          : "CC-GG-bridgy is inert until the Claude Code process wrapper is configured.",
        "Configure now",
      )
      .then((pick) => {
        if (pick === "Configure now") void setupWrapper(context)
      })
  }
}

export function deactivate(): void {
  if (pollTimer) clearInterval(pollTimer)
  if (usageTimer) clearInterval(usageTimer)
}
