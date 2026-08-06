# Gephyra — decisions

<!-- ## D-NNN — YYYY-MM-DD — title · Decision/Why/Scope/Supersedes · append-only, corrections supersede -->
<!-- decisions-format: 1 -->

What was chosen, what was rejected, and — most importantly — what was tried
and **failed**. [README.md](README.md) covers installation, use, architecture,
known issues and the roadmap; this file exists for the things working code
cannot tell you, above all the approaches already proven not to work.

Entries are append-only: corrections supersede rather than rewrite. Everything
here was validated on macOS against Claude Code extension 2.1.220.

## Verdict

Feasible without forking. The Claude Code extension is closed-source
(© Anthropic PBC, commercial ToS — the marketplace VSIX carries no OSS
license), so replicating its UI is out. But its own configuration surface
exposes everything a supervisor needs, and the session store is shared and
provider-agnostic, so the "cached session transfer" the concept called for
already exists natively.

## D-001 — 2026-07-26 — Mechanism: process-wrapper shim

**Scope:** repo

`claudeCode.claudeProcessWrapper` points at `bin/gephyra-wrapper`; the shim
injects provider env at CLI spawn based on per-project state.

**Rejected:** rewriting `claudeCode.environmentVariables` (machine-scoped, and
upstream bug #72261 "extension ignores claude environment settings" is open);
mutating `.claude/settings*.json` env blocks (leaks overrides to unrelated
sessions — this is cc-switch's approach).

## D-002 — 2026-07-26 — Busy gate: transcript quiescence watcher

**Scope:** repo

No busy context key exists in the extension — verified, its runtime
`setContext` calls are UI-state only (`sideBarActive`, `viewingProposedDiff`,
`lastClosedWasSession`, `sessionsListEnabled`, `primaryEditorEnabled`,
`updateSupported`, `doesNotSupportSecondarySidebar`). So gephyra finds the ACTIVE
session via Claude Code's live-session registry (`~/.claude/sessions/<pid>.json`
— identity + cwd + pid, no status field) and classifies busy/idle from that
transcript's tail plus its nested subagent activity.

**Why:** `pbauermeister/claude-busy-monitor` is prior art for the
idle/busy/asking state MODEL only — it reads probe files, not transcripts, and
is Linux-only; the transcript-tail heuristic is gephyra's own.

## D-003 — 2026-07-26 — Handoff UX: auto-relaunch + resume toast

**Scope:** repo

On toggle: flip state → toast with [New conversation] and [Reload window] → the
user picks the session to resume. Gated by `gephyra.switchToast` (amended
2026-07-27, default ON — it is the only surface teaching the handoff flow;
regular users turn it off once the flow is muscle memory).

**Superseded in part by [D-008](#d-008--2026-07-27--cli-restart-on-switch):**
this decision recorded "no resume-by-id command is contributed by the
extension". One was found later — `claude-vscode.editor.open(sessionId, prompt,
viewColumn)` — which is what makes live respawn possible. Do not re-derive the
old conclusion from this entry.

## D-004 — 2026-07-26 — Scope: per-project

**Scope:** repo

State keyed by workspace folder; the shim resolves the project from its cwd.
Gephyra toggles the PROVIDER and never touches the model choice — that stays the
user's per-task `/model` decision.

## D-005 — 2026-07-26 — Remote reach: beam over Anthropic's Remote Control

**Scope:** repo

`gephyra.beam` resumes the project's active session in an integrated
terminal under `--remote-control --permission-mode bypassPermissions`, with
provider env injected by beam itself (terminal spawns bypass the wrapper).

**Rejected:** building any web app or relay, bespoke or Happy-style — the whole
intended envelope (watch sessions, answer their questions, confirm completion,
send next steps, `/model` switching; config and screenshots explicitly out of
scope) is already covered by the RC mirror in the Claude apps, so zero UI to
maintain beats feature parity nobody asked for.

**Consequences:** host is the integrated terminal only — a window quit kills the
beam, a deliberate trade. The RC connect is explicit per beam; gephyra never
flips the "Enable Remote Control for all sessions" config.

## D-006 — 2026-07-27 — Provider model: named env profiles

**Scope:** repo · **Supersedes:** the fixed `anthropic | glm` pair

A provider is either the reserved `anthropic` (clean-env passthrough) or the
basename of `~/.config/gephyra/<name>.env` (charset `[A-Za-z0-9_-]+`,
matching what the shim accepts from state.json).

**Two invariants worth keeping:** usage adapters are keyed by the profile's
**base-URL hostname, not its name** (`*.z.ai` → GLM quota endpoint,
`*.kimi.com` → Kimi usages endpoint, anything else → "no usage adapter"), so
profile naming stays free; and a profile whose env file is missing resolves to
anthropic in BOTH the shim and the extension — the status bar must never claim a
provider the spawn wouldn't actually get.

## D-007 — 2026-07-27 — Model switching via the tier palette

**Scope:** repo

Claude Code's `/model` picker is fed by the
`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` family — **not** by the
provider's `/v1/models` (verified live: z.ai 404s that endpoint yet relabels;
Kimi serves it yet didn't relabel), and the opt-in gateway discovery drops any
id not starting `claude`/`anthropic`, making it useless for `glm-*`/`k3-*`. The
four tiers are therefore both the relabeling surface AND the model switcher,
capped at four visible, with `/model <raw-id>` passthrough as the escape hatch
for a fifth.

**Consequences:** profiles MUST set the full family plus
`CLAUDE_CODE_SUBAGENT_MODEL` — `ANTHROPIC_MODEL` alone sets the served model but
does not relabel rows — map tiers to DISTINCT models, and add
`*_MODEL_NAME`/`_DESCRIPTION` companions for friendly labels (those work behind
`ANTHROPIC_BASE_URL`; `*_SUPPORTED_CAPABILITIES` does not). Relabeling appears
only in a conversation spawned under the provider; `/status` is the ground truth.

## D-008 — 2026-07-27 — CLI restart on switch

**Scope:** repo · shipped shape as of 0.4.0

The extension keeps ONE CLI process per window and reuses it across
conversations, so a switched profile's env only landed after a window reload. It
exposes no restart command and watches no config that respawns the process, so
gephyra ends it: `pgrep -P <own pid>` (gephyra shares the extension host, so the
CLI is a sibling child), filtered to the Claude extension's install path so
language servers are never touched, then SIGTERM. Gated by
`gephyra.restartCliOnSwitch` (default ON; fail-open — pgrep errors are
swallowed and the old reload path still works).

On top of that, a switch respawns EVERY bound Claude panel in place: each is
busy-checked individually, closed, awaited until its registry entry disappears,
then reopened by session id via `claude-vscode.editor.open` in its original
column, focused panel last. Tab↔session binding lives in `src/tabs.ts` and
triangulates three signals — tabGroups open/close events, the per-spawn registry
entry, and an order-preserving 2s pairing poll with a 15s timestamp agreement
window so sidebar/terminal spawns can't steal a binding.

**Deferred kills:** pids backing open conversations in THIS workspace are queued
and killed once their registry entry disappears, so no "exited with code 143"
banner is ever painted into a live view. `registeredSessionPidsFor(projectPath)`
filters on `cwd == projectPath` AND `entrypoint == "claude-vscode"` — an
unfiltered version once made any open conversation in any project block every
switch.

**Why it looks like this:** reaching this shape took eleven iterations; the ones
that failed are in [Failed approaches](#failed-approaches--do-not-re-attempt)
and must not be re-attempted.

## D-009 — 2026-07-30 — Vision proxy: opt-in, scoped exception to the no-proxy stance

**Scope:** repo · maintainer-approved · **Amends:** [D-011](#d-011--2026-07-26--never-proxy-or-intercept-provider-traffic-never-touch-oauth-flows)

*Status: not needed for current operation* — z.ai repaired its injected
`analyze_image` tool on 2026-07-31 and GLM vision works natively again; the
proxy is retained, off by default, as the fallback if z.ai regresses.

**Mechanism:** an in-process `node:http` server (`src/visionProxy.ts`); when on
and an `anthropic-vision.env` with a PAYG key exists, it writes a
`visionProxyUrl` field into `state.json`, and the wrapper points non-anthropic
providers at `http://127.0.0.1:<port>/<provider>` (provider as path prefix, so
one proxy resolves the upstream). Routing is stateless body inspection: forward
to Anthropic iff the last user message carries an `image` block OR the last
message is a `tool_result` continuing a Claude-started loop — so a plain-text
follow-up returns to the provider immediately, with no "sticking".

**Fail-open is load-bearing:** the wrapper routes through the proxy ONLY while
`visionProxyUrl` is present; missing or unreachable ⇒ direct provider injection.
Claude Code never breaks because of the proxy.

**Resource safety:** one fixed port shared across windows (first to bind is
host, `EADDRINUSE` ⇒ health-probe ⇒ guest that promotes if the host dies);
shutdown calls `server.close()` + `closeAllConnections()` + a grace destroy of
tracked sockets so the port frees immediately; every request owns an
`AbortController` that tears down the upstream the moment the client socket
closes — no dangling SSE, no silent PAYG billing (validated: client abort closed
the upstream in ~26 ms).

## D-010 — 2026-08-03 — Live Anthropic usage is READ-ONLY: never refresh the CLI's token

**Scope:** repo · **Supersedes:** the refresh half of the 2026-07-29 decision

0.5.0–0.6.0 minted its own access token via a `refresh_token` grant to
`platform.claude.com/v1/oauth/token`, believing — from the CC 2.1.220 bundle —
that the refresh token was reusable and non-rotating. **It rotates.** The
credential belongs to the CLI, so every poll invalidated the CLI's copy; that is
what produced the "session expired on GLM stretches" re-logins blamed on natural
expiry. A second defect hid the first: the live endpoint returns `utilization` +
ISO-8601 `resets_at`, not the tee's `used_percentage` + unix seconds, so the
parse always failed and the readout silently fell back to the tee — the feature
never once showed a live number while logging the CLI out in the background.

**Now:** read `claudeAiOauth.accessToken` + `expiresAt` from the Keychain
(account `claude-code-user` first, unqualified read as fallback so a stray
second entry can't win), use it only while unexpired (60 s skew), otherwise skip
the cycle and let the tee answer — the CLI renews its own token on its next
turn. `usageWindow()` parses both field shapes.

**Invariant:** gephyra is a read-only consumer of another program's credential.
Any future feature that would write, refresh, or rotate one is out of bounds
without an explicit maintainer decision.

## D-011 — 2026-07-26 — Never proxy or intercept provider traffic; never touch OAuth flows

**Scope:** repo

Both providers are consumed exactly as their subscriptions intend.

- *Scoped exception — vision proxy* (opt-in `gephyra.visionProxy`, off by
  default; [D-009](#d-009--2026-07-30--vision-proxy-opt-in-scoped-exception-to-the-no-proxy-stance)).
  When enabled, a localhost pass-through forwards your own traffic verbatim to
  the configured provider and redirects only image-bearing turns to Anthropic
  under a PAYG key you provide. It rewrites nothing but the model field on those
  turns, inspects or stores no other content, and touches no OAuth flow. Off ⇒
  zero traffic proxied — the default and the shipped public posture.
- *Scoped exception — live Anthropic usage* (opt-in
  `gephyra.anthropicLiveUsage`, off by default). The statusline feed is
  terminal-only, so a panel-only user sees stale usage. When enabled, gephyra
  READS the access token Claude Code keeps in the macOS Keychain (service
  `Claude Code-credentials`, account `claude-code-user`) and GETs
  `api.anthropic.com/api/oauth/usage` with it — the same endpoint Claude Code
  itself uses. Strictly read-only per
  [D-010](#d-010--2026-08-03--live-anthropic-usage-is-read-only-never-refresh-the-clis-token):
  no token endpoint is ever called, no credential written, and an expired token
  is skipped rather than renewed. Fails open to the staled statusline feed.
- *Re-login is DELEGATED, not reimplemented* (2026-07-30, narrowed 2026-08-03).
  `gephyra.loginAnthropic` opens a terminal running `claude login`
  directly, bypassing the wrapper; Claude Code mints and stores the credential.
  gephyra writes no credentials, ever. The old auto-prompt on `invalid_grant` is
  gone with the refresh path — gephyra no longer performs the grant that could
  detect expiry, so re-login is user-initiated.

## D-012 — 2026-07-26 — No second chat UI

**Scope:** repo

The official extension remains the only conversation surface.

---

## Failed approaches — do not re-attempt

Every item here was implemented, shipped or tested, and reverted against live
evidence. The two open issues in the README ("mixed reopen order", "moved-tab
unbinding") are open *because* their obvious fixes are in this list.

- **`moveActiveEditor` to restore tab order** (0.3.10, reverted in 0.3.11).
  Reopening tabs then placing each with
  `moveActiveEditor {to: "position", by: "tab", value: originalIndex+1}`
  races focus — the reopened panel is not reliably the active editor when the
  command fires, so it moved the WRONG editors, including across groups where
  webview Tab objects get recreated and downstream references go stale. It
  reintroduced tab loss. **Mixed reopen order is the accepted cost; never
  trade tab integrity for cosmetics.**
- **Reopen-order-by-index without explicit placement** (0.3.9, reverted).
  Capturing each tab's index and reopening in original (column, index) order
  cannot work: VS Code inserts new tabs to the RIGHT OF THE ACTIVE tab, not at
  the group end, so append order never determines final order.
- **Pairwise binding transfer for moved tabs** (0.3.9, reverted in 0.3.10). A
  cross-group move arrives as a paired close+open in one tabGroups event with
  no new process spawned, so the binding can never re-pair. Transferring
  `closed[i]` → `opened[i]` mis-bound tabs in practice and made respawn bounce
  panels between groups. Moved tabs are deliberately left unbound — they keep
  their provider until closed and resumed.
- **Trusting `editor.open`'s return value as proof of success** (fixed in
  0.3.12). The extension's session→panel map can outlive the dead CLI process
  by a beat, so `createPanel` finds the DYING panel and reveals it without
  throwing: clean return, retry skipped, panel finishes dying, tab gone.
  `openSessionPanel` now counts Claude panels before the call and reports
  success only when a panel verifiably materialized (up to 1s watch).
  **Materialization, not absence-of-exception, is the success criterion.**
- **Binding a tab to any registry entry that appears after it opens** (fixed
  in 0.3.8). The panel-open flow fires short-lived WARM-UP spawns that also
  register, so a tab could bind to a warm-up's session id; respawning then
  reopened an id with no transcript → a blank "Untitled" panel where a real
  conversation was. Pairing now requires the candidate pid to still be ALIVE
  at drain time, and respawn refuses to close any tab whose bound session
  lacks transcript content.
- **Killing the CLI without re-resolving tabs at use time** (fixed in 0.3.7).
  Stale `Tab` snapshots after group renumbering made `close()` throw silently,
  and a swallowed catch turned any hiccup into a closed-never-reopened tab.
  Now: re-resolve from bindings at use time, treat close-failure as "tab
  untouched, skip", wait for deregistration before reopening, retry once after
  500 ms, and if it still fails show a warning naming the session. No silent
  failure paths remain in the respawn loop.
- **Refreshing the OAuth token** — see D-010. The refresh token rotates;
  refreshing logs Claude Code itself out.

The eleven-iteration history behind the respawn loop is the standing argument
for the README's next step: a harness for behaviour STATES (simulated registry
entries, scripted tab events, N-switch soak runs). Each fix above was correct
in isolation and only live use could falsify it.

## Spike findings that still bind

Most of the 2026-07-26 spike results are now just a description of shipped,
working code. These two are not — they record surprises that constrain the
implementation:

- **S1 — the wrapper argv contract (suspected shape falsified).** The
  extension invokes the wrapper with the REAL CLI as argv[1] — the bundled
  native-binary path, not the suspected empty-`executableArgs` bare-flags
  shape — followed by the full flag list. The executable-passthrough branch is
  the live one; the node/`*.js` and `find_cli` branches remain only as
  defense. The wrapper also routes `auth status --json` probes and a
  `--thinking disabled` warm-up, roughly three invocations per panel open.
- **S5 — live-session registry semantics.** Clean exits remove
  `~/.claude/sessions/<pid>.json`, on both a session's own exit and window
  close. **SIGKILL leaves a stale entry that nothing ever reaps** — not even a
  sibling's later clean shutdown — which is why `pidAlive()` in `src/busy.ts`
  is load-bearing rather than defensive. `peerProtocol` is a bare version int
  (`1`), so there is no richer status channel to adopt.
