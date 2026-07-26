import * as vscode from "vscode"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { classify, resolveActiveSession } from "./busy"
import { providerFor } from "./state"

// Beam = resume this project's active session in an integrated terminal with
// Remote Control enabled, so it becomes controllable from the Claude apps
// (claude.ai/code, iOS, Android) while execution stays on this machine. The
// extension UI exposes no Remote Control, but the session store is shared —
// the same native --resume handoff the provider toggle rides. Permission mode
// is locked to bypassPermissions: a beamed session exists to run unattended.

// glm.env is KEY=value lines, parsed and never sourced — the same contract
// the shell shim enforces. Terminal spawns bypass the wrapper, so beam must
// inject the provider env itself.
function glmEnv(): Record<string, string> | null {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(os.homedir(), ".config", "cc-gg-bridgy", "glm.env"), "utf8")
  } catch {
    return null
  }
  const env: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2]
  }
  return Object.keys(env).length > 0 ? env : null
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export async function beam(ws: string, quietWindowMs: number): Promise<void> {
  const active = resolveActiveSession(ws)
  if (!active) {
    void vscode.window.showWarningMessage(
      "CC-GG-bridgy: no Claude Code session found for this workspace yet — nothing to beam.",
    )
    return
  }
  if (classify(ws, quietWindowMs) === "busy") {
    const force = await vscode.window.showWarningMessage(
      "A Claude Code response may still be in flight. Beaming resumes this session in a second process — beam anyway?",
      { modal: true },
      "Beam anyway",
    )
    if (force !== "Beam anyway") return
  }

  const provider = providerFor(ws)
  let env: Record<string, string> | undefined
  if (provider === "glm") {
    env = glmEnv() ?? undefined
    if (!env) {
      void vscode.window.showWarningMessage(
        "CC-GG-bridgy: this project is on GLM but glm.env is missing — a beam now would run on Anthropic. Fix glm.env first.",
      )
      return
    }
  }

  const name = path.basename(ws)
  const terminal = vscode.window.createTerminal({
    name: provider === "glm" ? `Beam (GLM): ${name}` : `Beam: ${name}`,
    cwd: ws,
    env,
  })
  terminal.show()
  terminal.sendText(
    `claude --resume ${quote(active.sessionId)} --remote-control ${quote(name)} --permission-mode bypassPermissions`,
    true,
  )
  void vscode.window.showInformationMessage(
    active.live
      ? `Beamed ${name} — control it from the Claude app or claude.ai/code. The extension conversation still holds this session: close it, and don't reply from both surfaces.`
      : `Beamed ${name} — control it from the Claude app or claude.ai/code.`,
  )
}
