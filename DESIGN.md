# CC-GG-bridgy — design

Supervisor extension that switches the official Claude Code extension between
Anthropic and z.ai GLM per project, gated on session idleness, with native
session handoff. This is the engineering record — decisions, evidence, and
live spike validation (all on macOS, Claude Code extension 2.1.220); the
[README](README.md) covers installation and use. Decisions locked 2026-07-26.

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
5. **Remote reach: beam command over Anthropic's Remote Control** (added
   2026-07-26). `cc-gg-bridgy.beam` resumes the project's active session in
   an integrated terminal as `claude --resume <id> --remote-control <name>
   --permission-mode bypassPermissions`, under the project's provider env —
   terminal spawns bypass the wrapper, so beam injects glm.env itself. The
   owner's envelope (check active sessions remotely, answer their questions,
   confirm graceful completion, send next steps, /model switching; config
   and screenshots explicitly out of scope; permission mode locked to max)
   is fully covered by the RC mirror in the Claude apps, so building any
   web app or relay (bespoke or Happy-style) was rejected — zero UI to
   maintain beats feature parity nobody asked for. Host is the integrated
   terminal only (owner's call — accepts that a window quit kills the
   beam); the RC connect is explicit per beam — bridgy never flips the
   "Enable Remote Control for all sessions" config, which stays the user's
   own /config choice.

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
- `src/usage.ts` — dual-provider quota readout (verified live 2026-07-26).
  **Anthropic**: read from the statusline tee
  (`~/.config/cc-gg-bridgy/statusline-last.json`, written by a fail-safe
  block in `~/.claude/statusline-command.sh` — snippet in README) →
  `rate_limits.five_hour/seven_day` `used_percentage` + `resets_at` (unix
  SECONDS). Chosen over the community OAuth usage endpoint after that path
  401'd live: the Keychain access-token copy rots on this machine, and
  refreshing it ourselves would touch auth flows (non-goal). Limitation:
  only TERMINAL sessions run statusline scripts (the extension UI does
  not, verified), and `rate_limits` appears only after a real turn — the
  tooltip shows an "as of" note past 30 min. **z.ai**:
  `GET <origin>/api/monitor/usage/quota/limit` (bare-key Authorization,
  origin derived from glm.env's base URL) → `TOKENS_LIMIT` rows: hour-unit
  (3) = the 5h cycle, week-unit (6) = weekly, `TIME_LIMIT` = monthly MCP
  (not rendered). Fail-open everywhere — errors keep the last snapshot and
  carry the reason into the tooltip, 429 backs off 15 min. Poll: 5 min +
  on toggle. Status item shows the ACTIVE provider's 5h % inline; the
  tooltip shows both providers; the warning tint means "active 5h window
  ≥ 80%" (provider identity is text-only — the tint carries one signal).
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
- `src/beam.ts` — the beam command (locked decision 5). Resolves the active
  session via busy.ts's `resolveActiveSession()` (live-registry first, newest
  transcript fallback; the `live` flag drives the two-writer warning toast),
  busy-gates like the toggle, parses glm.env itself (terminal spawns bypass
  the wrapper), and opens an integrated terminal running
  `claude --resume <id> --remote-control <name> --permission-mode
  bypassPermissions`. Every early exit surfaces a message; permission mode
  is locked to max because a beamed session exists to run unattended.
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
- Remote Control support verified 2026-07-26: the system CLI (2.1.206) has
  `--remote-control [name]` and `--remote-control-session-name-prefix`; the
  bundled 2.1.220 binary carries the same symbols plus a webhook bridge that
  routes PR events over an RC connection. `--permission-mode` choices:
  acceptEdits, auto, bypassPermissions, manual, dontAsk, plan. RC itself is
  an Anthropic research preview (Feb 2026) — local execution, mirrored to
  claude.ai/code and the iOS/Android apps. Full round trip VALIDATED live
  2026-07-26: extension session → beam → phone control → `/exit` → resumed
  from the extension's LOCAL session list with all phone turns present (a
  beamed session never becomes a "web" cloud session; reopening the old
  conversation tab restores the stale pre-beam head — resume fresh from the
  list instead).
- An earlier CLI-level launcher pair (`glm -c` / `claude -c` shell aliases
  swapping the same env vars) proved the bidirectional session handoff in
  practice before this extension existed.
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
- **Beamed-session two-writer fork.** Beam resumes a session id the
  extension process may still hold (S5: registry says live). Interleaved
  JSONL appends are structurally fine, but replying from both surfaces forks
  the conversation DAG. Mitigation: the busy gate plus a live-flag toast
  telling the owner to close the extension conversation. Verified live
  (tmux probes, 2026-07-26): resume + `--remote-control` + bypass works and
  connects with no pairing step, and the CLI does NOT refuse resuming a
  session another live process holds — a second head opens silently on the
  same session (same RC URL), so the two-writer discipline is entirely on
  the user. GLM × RC is IMPOSSIBLE per the official docs: the CLI disables
  Remote Control whenever `ANTHROPIC_BASE_URL` points anywhere other than
  Anthropic. A GLM beam therefore opens a local-only terminal session
  (fail-open, still controllable at the desk); Happy-style tools are the
  only remote-reach option for the GLM leg.
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

- **NEXT TASK — GLM remote reach.** Official Remote Control is
  Anthropic-only (CLI hard-disables it under a foreign `ANTHROPIC_BASE_URL`),
  so GLM beams are local-only today. Investigate remote control for the GLM
  leg: Happy (open-source, E2E-encrypted, wraps the CLI so it inherits the
  injected env — the leading candidate), or other bridges. Evaluate against
  the owner's envelope (watch sessions, answer questions, confirm
  completion, send next steps, model switching) and a managed-Mac
  constraint (outbound-only connections).
- Button in the Claude view's title bar (`view/title` menu on
  `claudeVSCodeSidebar`/`claudeVSCodeSidebarSecondary`) beside the status-bar
  item, if Cursor honors foreign-view menu contributions.
- (Auto-resume shipped 2026-07-26 as the beam command — upgraded with
  `--remote-control` for phone/web reach; see locked decision 5.)
- Per-session provider badges in the status tooltip (which recent sessions ran
  on which provider, from transcript `model` fields).
- (Quota awareness shipped 2026-07-26 as `src/usage.ts` — both providers in
  the status tooltip, active 5h % inline.)
