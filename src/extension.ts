import * as vscode from "vscode"
import * as fs from "node:fs"
import * as path from "node:path"
import { classify, SessionActivity } from "./busy"
import { Provider, providerFor, setProvider, stateDir } from "./state"
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

function render(provider: Provider, activity: SessionActivity): void {
  const label = provider === "glm" ? "GLM" : "Claude"
  const icon = activity === "busy" ? "$(sync~spin)" : "$(arrow-swap)"
  const usage = currentUsage()
  const active = provider === "glm" ? usage.glm : usage.anthropic
  const fiveHourPct = (u: ProviderUsage | null): string | null =>
    u?.fiveHour ? `${Math.round(u.fiveHour.pct)}%` : null
  const aPct = fiveHourPct(usage.anthropic)
  const gPct = fiveHourPct(usage.glm)
  statusItem.text = [
    `${icon} ${label}`,
    ...(aPct ? [`C ${aPct}`] : []),
    ...(gPct ? [`G ${gPct}`] : []),
  ].join(" · ")
  statusItem.tooltip = new vscode.MarkdownString(
    [
      `**CC-GG-bridgy** — next Claude Code session runs on **${label}**`,
      "",
      usageLine("Claude", usage.anthropic, "7d"),
      "",
      usageLine("GLM", usage.glm, "wk"),
      "",
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
  render(providerFor(ws), classify(ws, quietWindowMs()))
}

async function toggle(): Promise<void> {
  const ws = workspacePath()
  if (!ws) {
    void vscode.window.showWarningMessage("CC-GG-bridgy: open a workspace folder first.")
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
  const next: Provider = providerFor(ws) === "glm" ? "anthropic" : "glm"
  setProvider(ws, next)
  void refreshUsage().then(refresh)
  refresh()
  const label = next === "glm" ? "GLM (z.ai)" : "Claude (Anthropic)"
  const picked = await vscode.window.showInformationMessage(
    `Now on ${label} for ${path.basename(ws)}. Start a new conversation, then resume the previous session from the Claude panel's session list to continue it there.`,
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
    vscode.commands.registerCommand("cc-gg-bridgy.setupWrapper", () => setupWrapper(context)),
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
