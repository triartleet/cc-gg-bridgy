# CC-GG-bridgy — design

Supervisor extension that switches the official Claude Code extension between
Anthropic and any Anthropic-compatible provider profile (z.ai GLM, Kimi Code,
…) per project, gated on session idleness, with native session handoff. This
is the engineering record — decisions, evidence, and live spike validation
(all on macOS, Claude Code extension 2.1.220); the [README](README.md) covers
installation and use. Decisions locked 2026-07-26; decision 6 added
2026-07-27.

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
   env) stays available manually. Amended 2026-07-27 (owner request): the
   toast is now gated by `ccGgBridgy.switchToast` (default ON — it is the
   only surface teaching the handoff flow to new users; the owner runs it
   off, the status-bar label change being confirmation enough).
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
6. **Provider model: named env profiles** (added 2026-07-27, supersedes the
   fixed `anthropic | glm` pair — the generalization was already parked on
   the roadmap). A provider is either the reserved `anthropic` (clean-env
   passthrough) or the basename of `~/.config/cc-gg-bridgy/<name>.env`
   (names restricted to `[A-Za-z0-9_-]+` — the charset the shim accepts
   from state.json). Discovery = directory scan; the toggle is a direct
   flip with exactly two providers and a QuickPick (with 5h usage) with
   more; the status item shows every provider's 5h % letter-coded. Usage
   adapters are keyed by the profile's base-URL hostname, NOT its name
   (`*.z.ai` → GLM quota endpoint, `*.kimi.com` → Kimi Code usages
   endpoint, anything else → "no usage adapter"), so profile naming stays
   free. A profile whose env file is missing resolves to anthropic in BOTH
   the shim and the extension — the status bar must never claim a provider
   the spawn wouldn't actually get. Kimi facts behind the adapter
   (endpoints, auth-var split, no server-side model mapping, quota schema)
   are recorded in the project memory note `kimi-provider-feasibility`
   (researched 2026-07-27, **not yet validated live** — no Kimi Code
   subscription at build time).
7. **Model switching via the tier palette** (added 2026-07-27). Investigated
   in depth: Claude Code's `/model` picker is fed by the
   `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` env-var family — NOT by
   the provider's `/v1/models` (verified live: z.ai 404s it yet relabels; Kimi
   serves it yet didn't relabel), and the opt-in gateway discovery drops any
   id not starting `claude`/`anthropic` (useless for `glm-*`/`k3-*`). The four
   tiers are therefore both the relabeling surface AND the model switcher: a
   profile maps each tier to a distinct provider model, so picking a tier in
   `/model` switches models live (no restart), capped at four visible — with
   `/model <raw-id>` passthrough as the escape hatch for any fifth+ model
   (verbatim behind a custom base URL, no recognition check). Profiles MUST set
   the full family + `CLAUDE_CODE_SUBAGENT_MODEL` (NOT `ANTHROPIC_MODEL` alone,
   which sets the served model but does not relabel rows), map tiers to DISTINCT
   models to make the switcher meaningful, and add `*_MODEL_NAME`/`_DESCRIPTION`
   companions for friendly picker labels (those work behind
   `ANTHROPIC_BASE_URL`; `*_SUPPORTED_CAPABILITIES` does not). Relabeling only
   appears in a conversation spawned under the provider — an Anthropic-started
   conversation has no provider env, so `/model` keeps Claude names by design;
   `/status` (transcript per-turn `model` field) is the ground truth. Mechanism
   recorded in the project memory note `model-picker-mechanism`.
8. **CLI restart on switch** (added 2026-07-27, amended same day). The
   Claude extension keeps ONE CLI process per window and reuses it across
   conversations (verified: a single `resources/native-binary/claude` child of
   the shared extension host, per window), so a switched profile's env — and
   with it the `/model` tier labels — only landed after a window reload. The
   extension exposes no restart command and watches no config that respawns
   it, so bridgy ends that process itself after a switch: `pgrep -P <own pid>`
   (bridgy shares the extension host, so the CLI is our sibling-child),
   filtered to the Claude extension's install path (or a resident shim copy) so
   language servers are never touched, then SIGTERM. The busy gate has already
   run by then, so only idle sessions are ended — and the post-switch flow
   already tells the user to start a new conversation, which now respawns
   through the wrapper with the fresh env. Gated by `ccGgBridgy.restartCliOnSwitch`
   (default ON — without it the switch silently doesn't apply to the model
   picker until reload, the worse surprise; fail-open: pgrep errors are
   swallowed and the old reload path still works).

   First implementation (0.3.1): deferred kills for processes with any
   live-session registry entry (= any open conversation anywhere) to avoid
   painting "exited with code 143" banners in conversation views. Bug:
   `registeredSessionPids()` was not filtered to the current workspace, so
   ANY open session in ANY project deferred ALL kills — switches did nothing
   if even one unrelated conversation was open (verified live 2026-07-27).

   Second implementation (0.3.2, this commit): added
   `registeredSessionPidsFor(projectPath)` — filters the registry to
   entries matching `cwd == projectPath` AND `entrypoint == "claude-vscode"`.
   Only pids backing open conversation views in THIS workspace defer the
   kill; others die immediately. Cross-project no longer blocks the switch.
   Deferred pids drain every 2s and are killed once their registry entry
   disappears (conversation closed — kill invisible). Honest trade: a NEW
   conversation spawned while a pre-switch conversation stays open *might*
   be handed an old-env process from the pending queue (self-heals when that
   conversation closes). Close the old conversation per the handoff flow.

   Third implementation (0.3.4): the deferred kill left the MAIN case
   broken — the ACTIVE panel's model picker mirrors its live process env,
   so it stayed on the old provider until reload (switching tabs doesn't
   respawn a live process; only spawn-time env counts). Fix: respawn the
   active panel in place. Discovery (bundle dig, 2.1.220): the extension's
   URI handler routes `/open?session=<id>` to
   `claude-vscode.primaryEditor.open(sessionId, prompt)` and its
   `createPanel` reveals an existing panel for that session OR creates a
   fresh one that spawns `--resume <id>` through the wrapper — i.e. a
   resume-by-id command EXISTS now, superseding decision 3's "none". So on
   switch, after the kill sweep (which only defers attached pids and thus
   can never race the fresh spawn): close the focused tab via the tabGroups
   API and reopen the session by id — clean exit (no banner), fresh spawn,
   new provider env, correct tier labels, no reload. Guarded to the
   unambiguous case: focused tab IS a Claude panel (`TabInputWebview`,
   viewType contains `claudeVSCodePanel` — the extension's own tab test)
   AND exactly ONE registered live conversation for this project — the
   registry cannot map panel→session, so with several open a reopen could
   hijack the tab with the wrong session; those fall back to the deferred
   path. Fail-open: any close/reopen error reverts to deferred kills.

   Fourth implementation (0.3.5): tab ↔ session binder (`src/tabs.ts`),
   removing the single-conversation guard for bound tabs. The extension
   never says which session a panel hosts, but three observable signals
   triangulate it: Claude panel tabs announce open/activate/close via the
   tabGroups API (`TabInputWebview`, viewType contains `claudeVSCodePanel`);
   every conversation spawn registers `~/.claude/sessions/<pid>.json`
   (sessionId, startedAt, entrypoint) moments later — including a lazy
   restored tab's spawn on FIRST activation; and the 2s poll pairs the two
   queues order-preserving (both monotonic), a pairing sticking only when
   the timestamps agree within 15s so sidebar/terminal spawns can't steal a
   tab's binding. Bound focused tab → switch respawns THAT session
   regardless of how many conversations are open (the main-case fix);
   unbound tabs keep the exactly-one-live-conversation fallback. Bindings
   die with their tab; the respawned panel re-binds itself through the same
   open→spawn→pair cycle. Also exports `activeBoundSessionId()` — a truer
   "active session" than newest-transcript-mtime, wired into beam as a
   next step.

   Fifth implementation (0.3.6): respawn-all. A switch now moves EVERY
   bound panel to the new provider, not just the focused one — each is
   closed and reopened by session id in its original column
   (`claude-vscode.editor.open(sessionId, prompt, viewColumn)` — verified
   signature; passing a non-Active column also sets the extension's
   preferred location to "panel", which matches the editor-tab workflow).
   Columns are captured before the first close (closing renumbers groups),
   the focused panel is respawned LAST so focus returns to it, and each
   session is busy-checked individually first (`sessionActivityFor`) — a
   background conversation mid-turn is never chopped; it keeps its old
   provider until closed, via the deferred-kill path. Unbound tabs keep
   the previous fallbacks unchanged.

   Sixth implementation (0.3.7): vanish-proofing the respawn. Live use
   showed 1–2 tabs missing after some switches — a close/reopen race:
   `createPanel` reveals (and throws on) the dying panel until its disposal
   is fully processed, and the loop's swallowed catch turned any hiccup
   into a silently closed-never-reopened tab; stale Tab snapshots after
   group renumbering could likewise make close() throw silently. Fixes:
   re-resolve each tab from the bindings at use time; treat close-failure
   as "tab untouched, skip"; after a successful close, wait for the
   session's registry entry to disappear (or its pid to die) before
   reopening — proof the extension finished the disposal; retry the reopen
   once after 500ms; and if it STILL fails, show a warning naming the
   session instead of vanishing it. No silent failure paths remain in the
   respawn loop.

   Seventh implementation (0.3.8), from live multi-switch testing:
   (a) Lost-tab root cause found — the panel-open flow fires short-lived
   WARM-UP spawns that also register in the live-session registry, so the
   tracker could bind a tab to a warm-up's session id; respawning then
   reopened an id with no transcript → blank "Untitled" panel where a real
   conversation was. Two-layer fix: pairing now requires the candidate's
   pid to still be ALIVE at drain time (warm-ups exit within seconds), and
   respawn refuses to close any tab whose bound session lacks transcript
   content (`resumableSession`). (b) Tab-row churn: the close/reopen loop
   is now three-phase — close all, await all deregistrations in parallel,
   reopen all — one row rebuild instead of one per tab. (c) Status-bar
   truth: the item shows the TOGGLE (next conversation) and now also
   "tab on <provider>" whenever the focused tab's transcript (last
   assistant turn's `model`, mapped through the profiles' *_MODEL values)
   disagrees — the tooltip explains the tab moves on its next respawn.

   Eighth implementation (0.3.9), polish on a working baseline (deliberately
   surgical): (a) In-group order preserved — each tab's index is captured
   with its column, reopens run in original (column, index) order (appends
   then reproduce the sequence), and focus is restored afterwards by
   re-opening the previously active session — which rides the extension's
   own reveal short-circuit for existing panels, creating nothing. (b)
   Cross-group MOVES no longer orphan a binding: a move arrives as a paired
   close+open inside one tabGroups event while spawning no new process (so
   a deleted binding could never re-pair); the handler now detects the pair
   and transfers bindings closed[i]→opened[i]. Real closes and real new
   tabs never pair, so those paths are untouched.

   Ninth implementation (0.3.10) — both 0.3.9 attempts corrected against
   live evidence. (a) The move-transfer is REVERTED: pairwise
   closed[i]→opened[i] mis-bound tabs in practice and made respawn bounce
   panels between groups; moved tabs are now deliberately unbound again
   (they keep their provider until closed and resumed — documented
   limitation, safe direction). (b) Reopen-order-by-index couldn't work:
   VS Code inserts new tabs to the RIGHT OF THE ACTIVE tab, not at the
   group end, so append order never determined final order. Replaced with
   explicit placement: after each reopen, while the new panel is still the
   active editor, `moveActiveEditor {to: "position", by: "tab", value:
   originalIndex+1}` puts it in its original slot — purely cosmetic, any
   failure is swallowed and changes nothing about the respawn itself.

   Tenth implementation (0.3.11) — 0.3.10's placement REVERTED after it
   reintroduced tab loss: `moveActiveEditor` races focus (the reopened
   panel is not reliably the active editor yet when the command fires), so
   it moved WRONG editors, including across groups where webview Tab
   objects get recreated and downstream references go stale. Lesson locked
   in as a comment at the site: mixed reopen order is the accepted cost —
   never trade tab integrity for cosmetics. The respawn loop is back to
   the exact 0.3.8-validated shape (open → retry → loud warning).

   Eleventh implementation (0.3.12) — the baseline's own rare loss mode
   found (a tab lost on the 4th consecutive switch, no warning shown): an
   `editor.open` can "succeed" as a silent no-op. The extension's
   session→panel map can outlive the dead CLI process by a beat, so
   createPanel finds the DYING panel and reveals it without throwing —
   return value clean, retry skipped, panel finishes dying, tab gone.
   Fix: `openSessionPanel` no longer trusts the command — it counts Claude
   panels before the call and reports success only when a panel verifiably
   materialized (up to 1s watch); otherwise the caller's 500ms-delayed
   retry runs, by which time the disposal has certainly been processed.
   Materialization, not absence-of-exception, is the success criterion.

   Released as 0.4.0 after 10 consecutive live multi-tab switches without
   loss. Open issues at release: mixed reopen order (parked — placement
   races focus, integrity beats cosmetics), moved-tab unbinding (parked —
   transfer heuristic reverted), boot-tab unbound until first pairing, and
   one unconfirmed single-loss sighting. NEXT TASK for this epic: a test
   harness for behaviour STATES — simulated live-session registry entries,
   scripted tab events, and N-switch soak runs — so every loss mode
   becomes a reproducible case instead of a tired-human observation. The
   eleven-iteration history above is the motivation: each fix was correct
   but only live use could falsify it.

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
                        └─ <name>    → parse <name>.env, exec real CLI
```

Components:

- `src/extension.ts` — activation, wrapper-setting bootstrap (consent-gated),
  status-bar item, toggle command, toast flow.
- `src/state.ts` — `state.json` read/write (`{projects: {path: provider},
  default: "anthropic"}`).
- `src/usage.ts` — per-provider quota readout (GLM+Anthropic verified live
  2026-07-26; profile adapters keyed by base-URL hostname since 0.3.0).
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
  (not rendered). **Kimi Code**: `GET <origin>/coding/v1/usages` (Bearer
  key; either `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` from the
  profile) — schema is community-documented only, two shapes observed
  ({usage, limits[]} object vs {data[]} by model_name), so extraction is
  defensive field-hunting and UNVERIFIED live. Fail-open everywhere —
  errors keep the last snapshot and carry the reason into the tooltip, 429
  backs off 15 min per provider. Poll: 5 min + on toggle. Status item
  shows every provider's 5h % inline (letter-coded); the tooltip shows all
  providers; the warning tint means "active 5h window ≥ 80%" (provider
  identity is text-only — the tint carries one signal).
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
  then `command -v claude`. Env profiles are parsed line-by-line (never
  sourced — a malformed value must not execute shell). The provider name is
  extracted from state.json by fixed-string key match (both quotes
  included, so one path can never prefix-match another) + a
  charset-restricted value capture that handles pretty-printed and compact
  separators; a malformed project value falls through to `default`
  (mirroring readState), anything unresolved fails closed to anthropic
  (table-tested: pretty/compact/missing/malformed/prefix-trap/spaces).
  `CC_GG_BRIDGY_DEBUG=1` logs argv/cwd and the chosen branch to a
  size-capped debug.log.

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
- **S6 — Kimi PAYG leg via env injection: PASS (validated live 2026-07-27,
  Moonshot Open Platform key — Kimi Code subscriptions were paused).**
  Chain validated bottom-up: balance endpoint
  (`GET /v1/users/me/balance`, Bearer) → key live;
  `POST /anthropic/v1/messages` (x-api-key) → proper Anthropic Messages
  shape served by `kimi-k3` with a `thinking` block (K3 thinks by
  default, confirmed); the NEW shim in an isolated fake-HOME injected all
  12 kimi.env vars for a kimi-mapped cwd and ZERO ANTHROPIC vars for a
  default cwd; `claude -p` under the profile env returned the exact
  sentinel with `modelUsage: kimi-k3`, contextWindow 262144 honored from
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, no login prompt (a benign
  "claude.ai connectors disabled" warning appears — expected under any
  provider override). Confirmed from usage fields:
  `cache_creation_input_tokens: 0` (Kimi ignores cache markers —
  implicit cache only; a cold `-p` turn read just 768 cached of 38.4k
  input tokens and cost **$0.195**, so PAYG is for spikes, not daily
  use). Balance readout lags billing (still $10.00 immediately after two
  billed calls). NOT yet validated: the Kimi Code plan endpoint
  (`api.kimi.com/coding/`), its auth-var behavior, and the
  `/coding/v1/usages` quota schema — blocked on subscriptions reopening.
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
- **Kimi Code plan endpoint + quota adapter not live-validated.** The PAYG
  leg is proven (S6: endpoint, env contract, slot pinning, CLI turn), but
  Kimi Code subscriptions have been paused since 2026-07-19 (K3 demand;
  batched reopening announced), so the plan endpoint's auth-var behavior
  and the `/coding/v1/usages` response shape remain open verification
  debt. Everything still degrades fail-open: wrong quota schema → "usage
  unavailable"; wrong env contract → the CLI's own auth error, never a
  broken Claude Code.
- **Model slot surprises under GLM / Kimi.** With the full tier family set
  (decision 7), `/model` relabels to the provider's model names in a
  provider-started conversation; a fresh conversation opens on the default
  tier (flagship). Gotchas that remain: an Anthropic-started conversation
  keeps Claude names in `/model` (no provider env at spawn); the picker is
  capped at four tiers (use `/model <raw-id>` for more); `/status` is the
  ground truth for what's actually serving.

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
- (Named env profiles shipped 2026-07-27 as locked decision 6 — any
  Anthropic-compatible endpoint via `<name>.env`, Kimi Code adapter
  included pending live validation.)
