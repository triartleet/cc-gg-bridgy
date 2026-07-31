# CC-GG-bridgy

<div align="center">
  <img src="media/bridgy-logo.png" width="220" alt="CC-GG-bridgy — a bee with a stinger, ready to switch providers">
  <p>
    <a href="https://marketplace.visualstudio.com/items?itemName=alkisyuv.cc-gg-bridgy"><img src="https://img.shields.io/visual-studio-marketplace/v/alkisyuv.cc-gg-bridgy?label=VS%20Marketplace&color=0066b8" alt="VS Marketplace"></a>
    <a href="https://open-vsx.org/extension/alkisyuv/cc-gg-bridgy"><img src="https://img.shields.io/open-vsx/v/alkisyuv/cc-gg-bridgy?label=Open%20VSX&color=a60ee5" alt="Open VSX"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  </p>
</div>

A tiny Cursor/VS Code companion extension that adds two things the official
Claude Code extension doesn't have. A **provider switch**: one status-bar
button moves your next Claude Code session between **Anthropic (Claude
subscription)** and any **Anthropic-compatible endpoint** you drop an env
profile for — **z.ai (GLM Coding Plan)** and **Kimi Code (Moonshot)** ship
with usage adapters — same extension UI, same session history, all
directions, with **every provider's 5-hour usage** side by side in the
status bar. And a **beam command**: the extension UI exposes no Remote
Control, so bridgy hands your active session to a terminal with it enabled
— one palette command and the session is on your phone, execution still on
your machine.

```text
⇄ Claude · C 28% · G 1% · K 7%
```

It is a **supervisor, not a fork**: the official Claude Code extension stays
untouched and does all the real work. Bridgy only decides which provider the
CLI process talks to at spawn time, gates switching on "no answer pending",
and walks you through resuming the conversation on the other side.

Validated live against Claude Code extension 2.1.220 (see
[DESIGN.md](DESIGN.md) for the design record and the spike evidence).

## Features

- **Per-project provider switch** — one workspace can run GLM or Kimi while
  every other window stays on Anthropic. Click the status-bar item to
  switch: with two providers it flips directly, with three or more it opens
  a picker. The next new conversation in that project uses the new provider.
  No window reload, no settings churn.
- **Named env profiles** — any `~/.config/cc-gg-bridgy/<name>.env` file is a
  provider. `glm.env` and `kimi.env` are the documented ones, but any
  Anthropic-compatible endpoint works (unknown endpoints just show no usage
  numbers).
- **Multi-provider usage readout** — the status item shows every provider's
  5-hour **and weekly** windows plus the next 5-hour reset, inline
  (`⇄ Claude │ C 28%/82% ↻14:00 · G 1%/40% ↻15:30`). The tooltip adds plan
  tiers and reset times. The item takes the warning tint when the active
  provider's 5-hour window passes 80%.
- **Live Anthropic usage (opt-in)** — the Claude column can read usage
  directly instead of waiting on the terminal statusline. Enable
  `ccGgBridgy.anthropicLiveUsage` and bridgy refreshes Claude Code's OAuth
  token from the macOS Keychain and polls the usage endpoint itself, so the
  bar stays fresh in the panel too. macOS only; fails open to the statusline
  feed on any miss. When the session expires it prompts a one-click re-login.
- **Vision on any provider (opt-in proxy)** — a provider whose gateway mangles
  images can still get working vision. An opt-in localhost proxy keeps the
  project on GLM/Kimi for text and code but routes image-bearing turns — and
  the tool-loops they start — to Anthropic pay-as-you-go, so your Claude
  subscription quota is untouched. Off by default; with it off, no traffic is
  proxied at all. *(z.ai GLM mangled images in mid-2026 but repaired its
  `analyze_image` tool on 2026-07-31, so GLM vision currently works natively;
  the proxy is kept as a fallback for if that regresses.)*
- **Busy gate** — switching is gated while a response looks in-flight, so a
  toggle can't corrupt an open turn; a forced switch asks for confirmation.
- **Native session handoff** — transcripts are provider-agnostic and shared,
  so after a toggle you just start a new conversation and resume the previous
  session from Claude Code's own session list. Nothing is copied or proxied.
- **Beam to phone (Remote Control)** — one command resumes the project's
  active session in an integrated terminal with Claude Code's Remote Control
  enabled, so you can watch it, answer its questions, and send it next steps
  from the Claude mobile/web apps while execution stays on your machine.
  Busy-gated like the toggle, and launched with
  `--permission-mode bypassPermissions` so the away-run doesn't stall on
  prompts.
- **Fail-open by design** — on any doubt (missing state, unreadable config,
  provider endpoint down) the wrapper execs the real CLI untouched and the
  usage rows show the reason instead of erroring. Claude Code keeps working
  even if bridgy is misconfigured or deleted.

## How it works

- **Process-wrapper shim.** Bridgy points `claudeCode.claudeProcessWrapper`
  (an official extension setting) at a small POSIX-sh shim. Every time the
  extension launches a Claude CLI process, the shim reads bridgy's
  per-project state and either execs the real binary clean (Anthropic) or
  with that provider's env profile injected. Each new conversation is its
  own CLI process, which is why the switch applies without a reload.
- **Per-project state** — `~/.config/cc-gg-bridgy/state.json` maps workspace
  path → provider name (plus a `default`). `anthropic` is reserved for the
  clean passthrough; every other name means "inject `<name>.env`". The shim
  resolves the project from the spawned process's cwd, which is the
  workspace folder.
- **Provider profiles** — `~/.config/cc-gg-bridgy/<name>.env` (never
  committed; strict `KEY=value` lines, parsed not sourced). `glm.env`, per
  z.ai's Claude Code docs:

  ```bash
  ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
  ANTHROPIC_AUTH_TOKEN=your-coding-plan-key
  ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1m]
  ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2[1m]
  ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4.7
  ANTHROPIC_SMALL_FAST_MODEL=glm-4.7
  ```

  `kimi.env`, per Moonshot's Kimi Code → Claude Code docs (their endpoint
  does **not** remap Claude model names, so every slot var is pinned; Tool
  Search isn't supported on their side):

  ```bash
  ANTHROPIC_BASE_URL=https://api.kimi.com/coding/
  ANTHROPIC_API_KEY=sk-kimi-your-coding-key
  ANTHROPIC_AUTH_TOKEN=sk-kimi-your-coding-key
  ANTHROPIC_MODEL=k3
  ANTHROPIC_DEFAULT_OPUS_MODEL=k3
  ANTHROPIC_DEFAULT_SONNET_MODEL=k3
  ANTHROPIC_DEFAULT_HAIKU_MODEL=kimi-for-coding
  CLAUDE_CODE_SUBAGENT_MODEL=kimi-for-coding
  CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144
  CLAUDE_CODE_AUTO_COMPACT_WINDOW=262144
  ENABLE_TOOL_SEARCH=false
  ```

- **Beam = native handoff + Remote Control.** The extension UI can't enable
  Anthropic's Remote Control (a research preview for terminal sessions), but
  the session store is shared — so beam resumes the project's active session
  in an integrated terminal as
  `claude --resume <id> --remote-control <name> --permission-mode bypassPermissions`,
  under the project's provider env. The session then appears in the Claude
  iOS/Android app and at claude.ai/code while execution stays local. Round
  trip verified: `/exit` the terminal and resume from the panel's local
  session list — phone turns included.
- **Busy detection** — bridgy finds the project's live session via Claude
  Code's session registry (`~/.claude/sessions/<pid>.json`), then classifies
  busy/idle from the transcript tail (including nested subagent activity).
  Long silent tool runs read as busy — the safe direction — and a 30-minute
  staleness escape stops a dead session from gating forever.
- **Usage sources** — profiles get a usage adapter picked by their base
  URL's hostname: z.ai profiles query the GLM Coding Plan quota endpoint,
  kimi.com profiles query the Kimi Code usage endpoint (community-documented
  — parsed defensively, degrades to "usage unavailable" on surprises), other
  endpoints show no numbers. The Claude side defaults to the `rate_limits`
  payload Claude Code hands to statusline scripts, teed to a file (see setup
  step 3) — no credential handling. With `ccGgBridgy.anthropicLiveUsage` on,
  the Claude side instead refreshes the OAuth token from the Keychain and
  polls the usage endpoint directly (panel-fresh; see below).
- **Tier-label fallback** — a provider profile that omits the
  `ANTHROPIC_DEFAULT_<TIER>_MODEL[_NAME]` vars inherits them from `glm.env`
  (the reference mapping) so `/model` shows real names instead of falling
  through to built-in Anthropic ids. Connection vars are never inherited, and
  a profile that sets its own tiers (like `kimi.env`) is untouched.
- **Vision proxy (opt-in)** — when on, bridgy hosts a localhost HTTP server
  and the wrapper points the CLI at `http://127.0.0.1:<port>/<provider>`
  instead of the provider directly. The proxy inspects each `/v1/messages`
  request: an image-bearing turn — or a tool-loop a Claude image turn started
  — goes to `api.anthropic.com` under a pay-as-you-go key with a Claude model;
  everything else forwards to the provider verbatim (original auth, untouched).
  The routing is stateless and only looks at the last message, so a plain text
  follow-up returns the conversation to GLM immediately. It fails open: no
  creds, no URL file, or proxy unreachable ⇒ the wrapper injects the provider
  env directly (today's behavior), so Claude Code never breaks because of it.

## Install

From a marketplace:

- **Cursor / VSCodium** — search **"cc-gg-bridgy"** in the Extensions panel
  (served from [Open VSX](https://open-vsx.org/extension/alkisyuv/cc-gg-bridgy)),
  or `cursor --install-extension alkisyuv.cc-gg-bridgy`.
- **VS Code** — install from the
  [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=alkisyuv.cc-gg-bridgy),
  or `code --install-extension alkisyuv.cc-gg-bridgy`.

Or build from source:

```bash
git clone https://github.com/triartleet/cc-gg-bridgy
cd cc-gg-bridgy
pnpm install
pnpm build
pnpm dlx @vscode/vsce package --no-dependencies
# Cursor:
cursor --install-extension cc-gg-bridgy-*.vsix   # or: code --install-extension …
```

Requires the official **Claude Code** extension, macOS or Linux (the shim is
POSIX sh — Windows would need a different wrapper), and pnpm/Node 20.

## Setup

1. **Configure the wrapper.** On first activation bridgy offers to point
   `claudeCode.claudeProcessWrapper` at its shim (a stable copy under
   `~/.config/cc-gg-bridgy/`, refreshed automatically on every activation).
   Decline and bridgy stays inert. This is a **global** setting — every
   window routes CLI spawns through the shim; on the Anthropic default the
   shim is a pure passthrough.
2. **Add provider profiles.** Create `~/.config/cc-gg-bridgy/<name>.env`
   files as shown above (`glm.env`, `kimi.env`, …). Each file becomes a
   provider in the switch; no files → the switch reports there's nothing to
   switch to.
3. **(Optional) Feed the Claude usage readout.** Claude Code only hands
   `rate_limits` to statusline scripts, so bridgy reads a tee of that
   payload. If you use a custom statusline, add this after it reads stdin
   (fail-safe — it can never break the status line itself):

   ```bash
   # after: input=$(cat)
   {
     bridgy_dir="$HOME/.config/cc-gg-bridgy"
     mkdir -p "$bridgy_dir" &&
       printf '%s' "$input" >"$bridgy_dir/statusline-last.json.tmp" &&
       mv -f "$bridgy_dir/statusline-last.json.tmp" "$bridgy_dir/statusline-last.json"
   } 2>/dev/null || true
   ```

   Without this, the Claude column shows why it's unavailable; everything
   else works.
4. **(Optional) Live Claude usage in the panel.** The statusline feed only
   updates from terminal sessions, so panel-only use shows a staleness age
   instead of a frozen number. To poll usage directly, set
   **`ccGgBridgy.anthropicLiveUsage: true`** (macOS only). Bridgy reads the
   Claude Code OAuth credential from the Keychain, refreshes the access token
   itself, and queries the usage endpoint — no credential handling of yours.
   When the refresh token eventually expires it prompts a one-click re-login
   (or run **`CC-GG-bridgy: Re-login Anthropic`**), which runs `claude login`
   and stores a fresh token bridgy then reads.
5. **(Optional) Vision on GLM/Kimi via the proxy.** Some provider gateways
   mangle pasted images — z.ai GLM did in mid-2026 (served a fixed wrong
   picture instead of yours) until it repaired its `analyze_image` tool on
   2026-07-31, so GLM vision currently works natively. This step is the
   fallback for if that regresses, or for another provider that mangles images:
   to keep text and code on GLM while routing image turns to Anthropic, put a
   pay-as-you-go Anthropic key in `~/.config/cc-gg-bridgy/anthropic-vision.env`:

   ```bash
   ANTHROPIC_API_KEY=sk-ant-your-payg-key
   # optional — override the vision model from the setting:
   # CC_GG_BRIDGY_VISION_MODEL=claude-haiku-4-5-20251001
   ```

   then set **`ccGgBridgy.visionProxy: true`**. The vision model is the
   **`ccGgBridgy.visionModel`** setting (default `claude-sonnet-5`; set it to
   e.g. `claude-haiku-4-5-20251001` for cheaper vision). Bridgy starts a
   localhost proxy: image turns route to Anthropic under your PAYG key (cents
   per image, billed to that key — your Claude subscription quota is
   untouched), while everything else stays on the provider. Off by default;
   off ⇒ nothing is proxied. The port is `ccGgBridgy.visionProxyPort`
   (default 4399), shared across windows.

## Using it

Click the **`⇄`** status-bar item to switch the current project: with two
providers it flips straight to the other one, with three or more it opens a
picker showing each provider's 5-hour usage. Then start a **new
conversation** (the toast offers it) — an open conversation keeps the
provider it started on, by design. To continue a conversation on the other
provider, resume it from Claude Code's session list; the transcript carries
over natively.

### Switching models (within a provider)

Each profile maps Claude Code's four model tiers — `fable` / `opus` / `sonnet` /
`haiku` — to a **distinct** model from that provider, so the native **`/model`
picker is your model switcher**: pick a tier, get that model, live, no restart.
The tiers relabel to the provider's model names (e.g. *Kimi K3 (flagship)*,
*Kimi K2.7 Code*, *GLM-5.2 (1M)*) because the profile sets the
`ANTHROPIC_DEFAULT_<TIER>_MODEL` family. Two things to know:

- **Relabeling only shows in a conversation that started under the provider.**
  `/model` reads the env at spawn time, so a conversation that started on
  Anthropic keeps showing Claude names forever — start a new conversation after
  switching providers to see the provider's models in `/model`.
- **More than four models?** Claude Code caps the picker at the four tiers, so
  for any model beyond them type it raw: **`/model kimi-for-coding-highspeed`**
  (or whatever the provider serves). Behind a custom endpoint the string is
  passed through verbatim — no recognition check.

Confirm what's actually serving a turn with **`/status`**, not `/model` — the
transcript's per-turn `model` field is the ground truth.

**Beam a session to your phone** before stepping away: run
**`CC-GG-bridgy: Beam session to phone (Remote Control)`** from the command
palette. Bridgy resumes the project's active session in an integrated
terminal with `--remote-control`, under the project's provider env (the
first beam may ask you to pair with your Claude account). The session then
shows up in the Claude iOS/Android app and at claude.ai/code, mirrored live
— answer its questions, send the next step, switch models with `/model`. If
the extension conversation for that session is still open, close it: two
surfaces replying to one session will fork it.

To come back, `/exit` the beamed terminal (Remote Control ends with the
process), then resume the session from the Claude panel's **local** session
list — a fresh resume re-reads the whole transcript, phone turns included.
Don't reopen the old conversation tab: it restores the stale pre-beam head.

Settings: `ccGgBridgy.quietWindowMs` — how long the transcript must be
silent before a session counts as idle (default 2500 ms).
`ccGgBridgy.switchToast` — the post-switch notification with the
[New conversation] shortcut (default on; turn off once the handoff flow is
muscle memory — the status-bar label change is the confirmation).
`ccGgBridgy.restartCliOnSwitch` — after a switch, end this window's idle
Claude Code CLI process so the next conversation respawns under the new
provider and `/model` shows its tier labels without a window reload
(default on; the Claude extension otherwise reuses one CLI process per
window, freezing the old provider's env until reload). Processes backing a
still-open conversation are ended only after that conversation closes, so
no "process exited" error ever appears in the panel. Open conversations
move with the switch: bridgy tracks which session each Claude tab hosts
and, on switch, closes and reopens every tracked tab on its own session —
fresh spawns under the new provider, `/model` tiers correct immediately,
each tab back in its original column with focus returning to the one you
were on (tabs flicker once). A conversation that is mid-response is never
interrupted — it keeps its old provider until you close it. Tabs bridgy
could not identify (open since before activation, ambiguous birth) keep
the old behavior: they move to the new provider when closed and resumed.

`ccGgBridgy.anthropicLiveUsage` — poll live Claude usage directly from the
usage endpoint instead of the terminal statusline feed (default off; macOS
only). On any miss it falls back to the statusline feed, shown with a
staleness age. When the OAuth refresh token expires, run
**`CC-GG-bridgy: Re-login Anthropic`** (auto-prompted once per expiry) to
mint a fresh one via `claude login`.

`ccGgBridgy.visionProxy` — route image-bearing turns to Anthropic
pay-as-you-go while keeping text and code on GLM/Kimi (default off). Requires
`~/.config/cc-gg-bridgy/anthropic-vision.env` with an `ANTHROPIC_API_KEY`. With
it on, bridgy hosts a localhost proxy that the wrapper routes non-Anthropic
providers through; off, nothing is proxied. `ccGgBridgy.visionProxyPort` — the
proxy's localhost port (default 4399, shared across windows).
`ccGgBridgy.visionModel` — the Claude model used for the vision leg (default
`claude-sonnet-5`; e.g. `claude-haiku-4-5-20251001` for cheaper vision;
overridable per provider via `CC_GG_BRIDGY_VISION_MODEL` in the env file). Logs
route to `~/.config/cc-gg-bridgy/vision-proxy.log`.

Debugging: `touch ~/.config/cc-gg-bridgy/debug-on` (or set
`CC_GG_BRIDGY_DEBUG=1` in the spawn env) makes the shim log its
argv/cwd/provider decision to `~/.config/cc-gg-bridgy/debug.log`
(size-capped). `CC_GG_BRIDGY_GLM_ENV` still overrides the glm.env path
(back-compat from the glm-only era; other profiles have no override).

## Known issues

Live-validated at 10 consecutive multi-tab switches without loss; these
remain open, roughly in priority order:

- **Reopened tab order is mixed.** VS Code inserts new tabs right of the
  active tab, and explicit post-open placement proved unsafe (it races
  focus and can move the wrong editors) — order preservation is parked
  until it can be done without risking tab integrity.
- **A tab dragged to another editor group loses its tracking.** The move
  recreates the tab identity without a new process to re-pair against;
  the tab keeps its provider until closed and resumed. A pairwise
  binding-transfer attempt made things worse and was reverted.
- **The tab focused at window load starts untracked** until the project's
  only conversation, or until you interact after another tab bound.
- **Rare single-tab loss is not fully excluded.** Three distinct loss modes
  were found and fixed (warm-up mis-binding, close/reopen disposal race,
  silent reveal-of-dying-panel); one unconfirmed sighting remains. If a
  reopen fails twice, a warning names the session — it is never silent.

Next step for all of the above: build a way to TEST behaviour states
deterministically instead of by hand — simulate registry entries, tab
events, and switch sequences (soak tests of N consecutive switches) so
each fix is provable and regressions are caught before a human notices.

## Limitations & caveats

- **A fresh GLM conversation may open on the small/fast model slot** (e.g.
  `glm-4.7`) depending on the panel's sticky model choice — check `/model`
  after switching. Bridgy deliberately never touches model choice.
- **GLM image input was broken (z.ai-side) — repaired upstream 2026-07-31;
  opt-in vision proxy retained as a fallback.** In mid-2026 z.ai's gateway
  converted an attached image to a hosted URL and routed it through its own
  `analyze_image` tool, which returned one fixed wrong image regardless of
  what you sent (verified against Claude Code 2.1.220). z.ai fixed that tool on
  2026-07-31 (verified on two images), so GLM vision works natively again. The
  opt-in **`ccGgBridgy.visionProxy`** (with an `anthropic-vision.env`, setup
  step 5) is kept — off by default — for if z.ai regresses: image turns route
  to Anthropic pay-as-you-go while text and code stay on GLM, spending no
  subscription quota. With the proxy off, the other fallback is to switch the
  project to Anthropic for vision (those turns run on your Claude subscription
  quota). Re-test GLM vision after a z.ai update.
- **Kimi: the pay-as-you-go leg is validated live** (Moonshot Open
  Platform endpoint, env contract, model-slot pinning, real CLI turn served
  by `kimi-k3`); the **Kimi Code plan endpoint and its usage readout are
  not yet** — new Kimi Code subscriptions were paused for capacity when
  this shipped. Their endpoint has documented gaps you should expect
  in-session: WebFetch is
  broken, Tool Search must stay disabled, prompt caching is Kimi's own
  implicit kind. `/model` relabels to Kimi names **only in a conversation
  started under Kimi** (see *Switching models*); an Anthropic-started one
  keeps Claude names. `/status` is the
  truth surface. The usage endpoint is community-documented; if its shape
  shifts, the Kimi column degrades to "usage unavailable" rather than
  breaking anything.
- **Claude usage freshness rides on terminal use.** The extension UI doesn't
  run statusline scripts, so the Claude column updates when a terminal
  `claude` session makes a turn; past 30 minutes it's marked "as of HH:MM".
  The GLM column is always live.
- **The busy heuristic reads safe, not perfect.** Long silent tool
  executions and permission prompts read as busy; the forced-switch confirm
  covers the rest.
- **Beam is a handoff, not a mirror, on the desk side.** The extension panel
  won't show turns made from the phone — reopen the session from Claude
  Code's session list when you're back. Remote Control itself is an Anthropic
  research preview tied to your Claude account login, and it is disabled by
  the CLI whenever `ANTHROPIC_BASE_URL` is set — so a beamed GLM or Kimi
  session runs as a normal local terminal session without phone reach.
  Bridgy never flips the "Enable Remote Control for all sessions" setting —
  ambient reach for plain terminal sessions stays your own `/config` choice.
- **Closed-source churn.** Anthropic can change the wrapper setting or spawn
  path in any release (the extension auto-updates). The shim fails open, so
  the failure mode is "toggle silently does nothing", never a broken Claude
  Code — re-verify after major extension updates.
- Cosmetics: the extension UI may render Claude model names in some places
  while under GLM; the status bar is the truth surface for the provider.

## Roadmap

- **Alt-provider remote reach** (next up): official Remote Control is
  Anthropic-only (the CLI disables it whenever `ANTHROPIC_BASE_URL` is set),
  so investigate remote control for GLM/Kimi-served sessions — Happy-style
  open-source bridges, or other angles.
- Live-validate the Kimi leg against a real Kimi Code subscription (auth
  var, model slots, usage response shape).
- Button in the Claude panel's title bar beside the status-bar item.
- Per-session provider badges in the tooltip (from transcript `model`
  fields).
- (Named env profiles shipped in 0.3.0 — any Anthropic-compatible endpoint
  via `<name>.env`.)

## Disclaimer

Not affiliated with Anthropic, Z.ai, or Moonshot AI. By default bridgy never
proxies or intercepts provider traffic and never touches OAuth flows — it only
sets an official extension setting and injects documented environment
variables, so each provider is consumed exactly as its subscription intends.
The one scoped exception is the opt-in vision proxy
(`ccGgBridgy.visionProxy`, off by default): when enabled it runs a localhost
pass-through that forwards your own traffic verbatim to your configured
provider, redirecting only image-bearing turns to Anthropic under a
pay-as-you-go key you provide — it rewrites nothing but the model field on
those turns, inspects or stores no other content, and touches no OAuth flow.
Claude Code is a product of Anthropic, PBC; use of each provider is governed
by its own terms.

## License

[MIT](LICENSE)
