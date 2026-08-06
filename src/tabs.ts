import * as vscode from "vscode";
import { registeredSessions } from "./busy";
import { canonical } from "./state";

// Passive tab ↔ session binder. The Claude extension never says which
// session a webview panel hosts, but three signals triangulate it: panel
// tabs announce open/activate/close via the tabGroups API, every
// conversation spawn registers ~/.claude/sessions/<pid>.json (sessionId +
// startedAt) moments later, and gephyra's 2s poll pairs the two. Pairing is
// order-preserving — both sequences are monotonic — and only sticks when
// the timestamps agree within PAIR_WINDOW_MS, so a sidebar or terminal
// spawn cannot steal a tab's binding. Tabs that never bind (ambiguous
// birth, opened before gephyra activated) just keep the conservative
// fallbacks that existed without the tracker.

const PAIR_WINDOW_MS = 15_000;

const bindings = new Map<vscode.Tab, string>();
const pending: { tab: vscode.Tab; at: number }[] = [];
let lastActive: vscode.Tab | undefined;

export function isClaudePanel(tab: vscode.Tab): boolean {
  return (
    tab.input instanceof vscode.TabInputWebview &&
    tab.input.viewType.includes("claudeVSCodePanel")
  );
}

function enqueue(tab: vscode.Tab): void {
  if (bindings.has(tab)) return;
  if (pending.some((p) => p.tab === tab)) return;
  pending.push({ tab, at: Date.now() });
}

export function initTabTracker(context: vscode.ExtensionContext): void {
  for (const group of vscode.window.tabGroups.all)
    for (const tab of group.tabs)
      if (isClaudePanel(tab) && tab.isActive) lastActive = tab;
  context.subscriptions.push(
    // NOTE: cross-group tab MOVES orphan their binding (the move recreates
    // the Tab object with no new spawn to re-pair against). A pairwise
    // close+open transfer was tried (0.3.9) and REVERTED — it mis-bound
    // tabs and made respawn bounce panels between groups. Moved tabs are
    // simply unbound: they keep their provider until closed and resumed.
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.opened) if (isClaudePanel(tab)) enqueue(tab);
      for (const tab of e.changed)
        if (isClaudePanel(tab) && tab.isActive) {
          lastActive = tab;
          // A restored (lazy) tab spawns its process on first activation —
          // enqueue so that spawn can bind it; already-bound tabs no-op.
          enqueue(tab);
        }
      for (const tab of e.closed) {
        bindings.delete(tab);
        const i = pending.findIndex((p) => p.tab === tab);
        if (i !== -1) pending.splice(i, 1);
        if (lastActive === tab) lastActive = undefined;
      }
    }),
  );
}

// Called from the 2s poll: pair pending tabs with newly registered
// conversations of this project, oldest-to-oldest.
export function drainTabBindings(ws: string): void {
  const now = Date.now();
  while (pending.length > 0 && now - pending[0].at > PAIR_WINDOW_MS)
    pending.shift();
  if (pending.length === 0) return;
  const wsKey = canonical(ws);
  const bound = new Set(bindings.values());
  // The panel-open flow also fires short-lived warm-up spawns that register
  // and exit within seconds; requiring a LIVE pid keeps them from stealing
  // a tab's binding (a warm-up binding reopens as a blank Untitled panel).
  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const fresh = [...registeredSessions().entries()]
    .filter(
      ([pid, s]) =>
        s.entrypoint === "claude-vscode" &&
        canonical(s.cwd) === wsKey &&
        !bound.has(s.sessionId) &&
        pidAlive(pid),
    )
    .map(([, s]) => s)
    .sort((a, b) => a.startedAt - b.startedAt);
  while (pending.length > 0 && fresh.length > 0) {
    const p = pending[0];
    const s = fresh[0];
    if (Math.abs(s.startedAt - p.at) > PAIR_WINDOW_MS) {
      // Timestamps disagree: whichever side is older can never pair — drop
      // it and retry (an old unbound session, or a tab whose spawn never
      // materialized).
      if (s.startedAt < p.at) fresh.shift();
      else pending.shift();
      continue;
    }
    bindings.set(p.tab, s.sessionId);
    pending.shift();
    fresh.shift();
  }
}

// All currently bound panels, for whole-window operations like respawn-all.
// 'closed' events delete their entries, so every tab here is live.
export function boundClaudeTabs(): { tab: vscode.Tab; sessionId: string }[] {
  return [...bindings.entries()].map(([tab, sessionId]) => ({
    tab,
    sessionId,
  }));
}

// The session behind the focused Claude panel (or the last one focused).
export function sessionIdForTab(tab: vscode.Tab): string | undefined {
  return bindings.get(tab);
}

export function activeBoundSessionId(): string | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab && isClaudePanel(tab)) {
    const id = bindings.get(tab);
    if (id) return id;
  }
  return lastActive ? bindings.get(lastActive) : undefined;
}
