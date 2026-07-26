# CC-GG-bridgy — design

Supervisor extension that switches the official Claude Code extension between
Anthropic and z.ai GLM per project, gated on session idleness, with native
session handoff. Decisions locked with the owner on 2026-07-26.

## Verdict

Feasible without forking. The Claude Code extension is closed-source
(© Anthropic PBC, commercial ToS — the marketplace VSIX carries no OSS
license), so replicating its UI is out. But its own configuration surface
exposes everything a supervisor needs, and the session store is shared and
provider-agnostic, so the "cached session transfer" the concept called for
already exists natively.

## Locked decisions (2026-07-26)

1. **Mechanism: process-wrapper shim.** `claudeCode.claudeProcessWrapper`
   points at `bin/cc-gg-wrapper`; the shim injects GLM env at CLI spawn based
   on per-project state. Chosen over rewriting `claudeCode.environmentVariables`
   (machine-scoped; upstream bug #72261 "extension ignores claude environment
   settings" is open) and over mutating `.claude/settings*.json` env blocks
   (leaks overrides to unrelated sessions; cc-switch's approach).
2. **Busy gate: transcript quiescence watcher.** No busy context key exists in
   the extension (verified: its runtime `setContext` calls are UI-state only —
   they include `sideBarActive`, `viewingProposedDiff` (both prefixes),
   `lastClosedWasSession`, `sessionsListEnabled`, `primaryEditorEnabled`,
   `updateSupported`, `doesNotSupportSecondarySidebar`). Bridgy finds the
   ACTIVE session via Claude Code's live-session registry
   (`~/.claude/sessions/<pid>.json` — identity + cwd + pid, no status field;
   verified present on this macOS) and classifies busy/idle from that
   transcript's tail plus its nested subagent activity.
   `pbauermeister/claude-busy-monitor` is prior art for the idle/busy/asking
   state MODEL only — it reads the probe files, not transcripts, and is
   Linux-only; the transcript-tail heuristic here is bridgy's own.
3. **Handoff UX: auto-relaunch + resume toast.** On toggle: flip state → toast
   with [New conversation] (`claude-vscode.newConversation`) and
   [Reload window] fallback → user picks the session to resume from the
   extension's own list. No resume-by-id command is contributed by the
   extension, so full automation would mean driving its webview blindly —
   rejected for v1. Terminal fallback (`claude --resume <id>` under swapped
   env) stays available manually.
4. **Scope: per-project.** State keyed by workspace folder; the shim resolves
   the project from its cwd. A scratch repo can run GLM while another project
   stays on Anthropic (Fable/Opus — the owner switches models per task via
   /model; bridgy toggles the PROVIDER and never touches the model choice) in
   the same instant.

## Architecture

```plaintext
┌─ Cursor window ──────────────────────────────────────────────┐
│  Claude Code extension (untouched, closed-source)            │
│    └─ spawns CLI via claudeCode.claudeProcessWrapper ──────┐ │
│  CC-GG-bridgy extension                                    │ │
│    ├─ status-bar button  [Claude ⇄ GLM]  (busy-gated)      │ │
│    ├─ busy watcher  (poll newest session JSONL, 2s)        │ │
│    └─ writes ~/.config/cc-gg-bridgy/state.json             │ │
└────────────────────────────────────────────────────────────┼─┘
                                                             ▼
                      bin/cc-gg-wrapper (shell shim)
                        reads state.json for $PWD
                        ├─ anthropic → exec real CLI, env clean
                        └─ glm       → source glm.env, exec real CLI
```

Components:

- `src/extension.ts` — activation, wrapper-setting bootstrap (consent-gated),
  status-bar item, toggle command, toast flow.
- `src/state.ts` — `state.json` read/write (`{projects: {path: provider},
  default: "anthropic"}`).
- `src/busy.ts` — activity classification. Project slug = workspace path with
  every non-alphanumeric → `-` (verified against `~/.claude/projects/`
  entries). The active transcript comes from the live-session registry (cwd
  match + pid alive), falling back to newest top-level mtime. Busy when the
  newest activity (transcript OR its session's nested subagent/workflow
  JSONLs — verified: workflows write only to the nested files while the
  top-level tail reads closed) is inside the quiet window, or the tail
  implies an open turn: a genuine user prompt / tool_result, or an assistant
  record without a terminal `stop_reason` ∈ {end_turn, stop_sequence,
  refusal} (the exact terminal set observed across the 134-transcript
  corpus). User tails that await nothing — interrupts, slash-command echoes,
  task notifications — read idle (21/134 historical transcripts end that
  way), a 30-min staleness escape stops a dead session reading busy forever,
  and an unparseable tail window widens then fails toward busy, never idle
  (single records up to 1.9 MB exist in the corpus).
- `bin/cc-gg-wrapper` — POSIX sh, run from a STABLE copy at
  `~/.config/cc-gg-bridgy/cc-gg-wrapper` (the extension refreshes the copy on
  activation; an install-dir path would go stale on every bridgy update and
  break Claude Code's launch). Defensive about the wrapper argv contract
  (spike S1): bare `node`/`*.js` argv resolves the interpreter via
  `command -v`, a regular executable file passes through, anything else falls
  back to the newest-by-mtime bundled binary
  (`~/.cursor/extensions/anthropic.claude-code-*/resources/native-binary/claude`)
  then `command -v claude`. glm.env is parsed line-by-line (never sourced —
  a malformed value must not execute shell). `CC_GG_BRIDGY_DEBUG=1` logs
  argv/cwd and the chosen branch to a size-capped debug.log.

## Evidence register (verified 2026-07-26 on this machine, ext 2.1.220)

- Extension installs at
  `~/.cursor/extensions/anthropic.claude-code-2.1.220-darwin-arm64/` with a
  bundled native CLI (`resources/native-binary/claude`, ~257 MB) and webview
  assets; `extensionKind: workspace`; no OSS license.
- `claudeCode.claudeProcessWrapper` (machine scope) exists: "Executable path
  used to launch the Claude process." Bundle code passes the wrapper path
  through verbatim as `pathToClaudeCodeExecutable` (the shell-path resolution
  feeds the spawn env's PATH, not the wrapper path); when a `cli.js` fallback
  is in play `executableArgs` is `[node, cli.js]`, else `[]` — supporting
  S1's empty-args expectation for the native binary.
- Spawn env = `{...process.env}` + `claudeCode.environmentVariables` entries +
  `CLAUDE_CODE_ENTRYPOINT=claude-vscode` (read from the bundle), and the CLI
  itself resolves `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` /
  `ANTHROPIC_DEFAULT_{OPUS,SONNET}_MODEL` from env (symbols present in both
  extension.js and the binary).
- Contributed commands include `claude-vscode.newConversation`,
  `claude-vscode.sidebar.open`, `claude-vscode.editor.open`,
  `claude-vscode.reopenClosedSession`, `claude-vscode.focus`; sessions-list
  view `claudeVSCodeSessionsList` exists behind
  `claude-vscode.sessionsListEnabled`.
- Terminal and extension sessions share one store: `entrypoint=cli` and
  `entrypoint=claude-vscode` transcripts interleave in
  `~/.claude/projects/<slug>/`; assistant lines carry their serving `model`,
  so transcripts are provider-agnostic.
- CLI supports `-r/--resume [sessionId]`, `--continue`, `--fork-session`,
  `--session-id <uuid>` (from `claude --help`).
- The owner's earlier `glm -c` / `claude -c` launcher pair proved the
  bidirectional CLI-level handoff in practice — but the `glm` launcher is
  ABSENT from this machine as of 2026-07-26 (`command -v glm` fails; not in
  `~/.local/bin`), so the working z.ai env values must be re-established in
  `glm.env` from the Coding Plan dashboard, not copied from it.
- Prior art: no GLM UI extension for Cursor exists (ZCode is a standalone
  desktop app; z.ai's Cursor doc configures Cursor's NATIVE model settings
  over the OpenAI protocol, and its Claude-Code path is CLI env vars — which
  is exactly what the wrapper injects). farion1231/cc-switch (121k★, MIT)
  hot-switches Claude Code provider config by rewriting config files, but
  globally and outside the IDE.

## Spike results (validated live 2026-07-26, EDH + ext 2.1.220)

- **S1 — wrapper argv contract: PASS (suspected shape falsified).** The
  extension invokes the wrapper with the REAL CLI as argv[1] — the bundled
  native-binary path, not the suspected empty-executableArgs bare-flags shape
  — followed by the full flag list (`--output-format stream-json --verbose
  --input-format stream-json --permission-prompt-tool stdio …`). The
  executable-passthrough branch is the live one; node/`*.js` and `find_cli`
  stay as defense. The wrapper also routes `auth status --json` probes and a
  `--thinking disabled` warm-up session — about three invocations per panel
  open, all in debug.log.
- **S2 — process lifecycle: PASS.** Each conversation is its own CLI process:
  after a toggle, a NEW conversation spawned a fresh pid through the wrapper
  (provider=glm, env injected) with no window reload. Messages and `/model`
  inside an existing conversation reuse its process, so an open conversation
  keeps the provider it started on — the [New conversation] handoff path is
  exactly right.
- **S3 — wrapper cwd: PASS.** Every logged spawn (Anthropic and GLM legs) had
  cwd == the window's workspace folder; per-project resolution via `pwd -P`
  works as designed.
- **S4 — GLM auth via wrapper env: PASS.** Injected `ANTHROPIC_BASE_URL` /
  `ANTHROPIC_AUTH_TOKEN` were honored with NO login prompt
  (`disableLoginPrompt` not needed). Transcript evidence: haiku-slot reply
  served by `glm-4.7`; after `/model glm-5.2[1m]`, served by `glm-5.2`. The
  native binary knows all slot vars incl. `ANTHROPIC_DEFAULT_FABLE_MODEL`
  (symbol-checked). Caveat: a fresh GLM conversation may open on the
  small/haiku slot — check `/model` after a toggle; bridgy never touches
  model choice (decision 4).
- **S5 — live-session registry semantics: PASS.** Clean exits remove
  `~/.claude/sessions/<pid>.json` — observed on both a session's own exit
  and window close. SIGKILL leaves a stale entry that nothing reaps, not
  even a sibling's later clean shutdown (observed via `kill -9`), so
  busy.ts's `pidAlive()` guard is load-bearing. `peerProtocol` is a bare
  version int (`1`) — no richer status channel to adopt; the transcript-tail
  heuristic stays.

## Risks

- **Closed-source churn.** Anthropic can rename `claudeProcessWrapper` or
  change the spawn path in any release; the extension auto-updates. Mitigate:
  the shim fails open (exec the real binary untouched on any doubt) and the
  status bar shows the provider it *believes* is active, sourced from state,
  not from inspection.
- **Upstream env-handling bugs.** Issue #72261 (extension ignores env
  settings) shows this surface moves; the wrapper bypasses the settings layer
  but S4 must re-verify after extension updates.
- **Busy heuristic gaps.** Long silent tool executions and permission prompts
  read as busy (safe direction); a dead session with an open-looking tail
  reads busy until the 30-min staleness escape flips it. Acceptable v1
  trade — the forced-switch confirm exists.
- **Model slot surprises under GLM.** The `/model` list reflects the mapped
  GLM names (verified live — better than the "UI still shows Claude names"
  fear), but a fresh conversation may open on the small/haiku slot rather
  than the flagship mapping. The status bar stays the provider truth surface;
  model choice stays the user's.

## Non-goals

- Never proxy or intercept provider traffic; never touch OAuth flows. Both
  providers are consumed exactly as their subscriptions intend (Anthropic
  first-party; z.ai's own Anthropic-compatible Coding Plan endpoint).
- No second chat UI. The official extension remains the only conversation
  surface.

## v2 ideas (parked)

- Button in the Claude view's title bar (`view/title` menu on
  `claudeVSCodeSidebar`/`claudeVSCodeSidebarSecondary`) beside the status-bar
  item, if Cursor honors foreign-view menu contributions.
- Auto-resume: open an integrated terminal running
  `claude --resume <newest-session-id>` under the target env when the user
  prefers terminal UI.
- Quota awareness: surface the GLM 5-hour window (Z.ai usage tracker exists as
  a separate extension; bridgy could inline the number next to the toggle).
- Per-session provider badges in the status tooltip (which recent sessions ran
  on which provider, from transcript `model` fields).
