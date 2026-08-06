# Gephyra

<div align="center">
  <img src="media/gephyra-logo.png" width="520" alt="Gephyra — a bridge from your editor to whichever provider you pick">
  <p>
    <a href="https://marketplace.visualstudio.com/items?itemName=alkisyuv.gephyra"><img src="https://img.shields.io/visual-studio-marketplace/v/alkisyuv.gephyra?label=VS%20Marketplace&color=0066b8" alt="VS Marketplace"></a>
    <a href="https://open-vsx.org/extension/alkisyuv/gephyra"><img src="https://img.shields.io/open-vsx/v/alkisyuv/gephyra?label=Open%20VSX&color=a60ee5" alt="Open VSX"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  </p>
</div>

One AI subscription answers every project you work on, so they all drain the same allowance — and when you hit the limit, everything stops, whether a project needed the expensive plan or not. Gephyra adds a switch to the Claude Code extension in Cursor and VS Code so each project can pick its own provider — the company and subscription that answers your AI requests. The other providers are separate subscriptions you sign up and pay for yourself; gephyra connects them, it doesn't include them. Installing gephyra changes nothing until you accept the one pop-up question it shows and opt a project in. And if it is ever broken, misconfigured, or deleted, Claude Code keeps working as if gephyra were never installed.

Works on macOS and Linux (not Windows), alongside the official Claude Code extension.

Your status bar afterwards — one meter per subscription (C = Claude, G = GLM, K = Kimi):

```text
⇄ Claude · C 28% · G 1% · K 7%
```

## Your first switch

1. **Install gephyra and accept the one-time pop-up question** it shows — that single yes is all the setup Claude Code itself needs. If you decline, gephyra does nothing at all. Details in [Install](#install).
2. **Add one provider.** [Provider setup](#provider-setup) walks you through it: you copy a short ready-made block into a small text file and paste in the sign-in details the provider gives you — the blocks for z.ai's GLM plan and Moonshot's Kimi plan are ready to copy. Each provider you add becomes one choice on the switch.
3. **Click the `⇄` item in the status bar and start a new conversation.** That conversation is answered by the provider you just picked — in this project only.

From then on the meter at the bottom of the window shows how much of each subscription's allowance you've used and when it resets, side by side.

## What you get

- **A per-project switch** — a switch changes which provider this project's next conversations use; other projects and windows are untouched. → [Everyday use](#everyday-use)
- **Any compatible provider** — each one is a small saved file with its connection details; GLM and Kimi also show their allowance numbers in the meter, other providers work but show no numbers. → [Provider setup](#provider-setup)
- **Side-by-side usage meters** — the status bar readout shows every subscription's allowance and reset time at once. → [Usage readouts](#usage-readouts)
- **Live Claude usage** *(opt-in, off by default; macOS only)* — the Claude number refreshes on its own instead of waiting for other activity. → [Usage readouts](#usage-readouts)
- **Vision fallback** *(opt-in, off by default)* — if a provider mishandles images, the messages that carry images can be answered by Claude instead, billed per use to a separate account you set up: an extra cost, and only if you turn this on. → [Settings reference](#settings-reference)
- **The busy gate** — while an answer is being written, switching waits; forcing it asks you first. → [Everyday use](#everyday-use)
- **Conversations carry over** — continue any conversation on the other provider from Claude Code's own list of past conversations; nothing is copied. → [Everyday use](#everyday-use)
- **Beam to phone** — beam is sending an ongoing conversation to your phone while the work keeps running on your computer; it needs the Claude app on your phone, signed in to your Claude account. → [Everyday use](#everyday-use)
- **Fail-open safety** — gephyra failing can never take Claude Code down with it; the worst case is that the switch quietly does nothing. → [Under the hood](#under-the-hood)

## How it works, in plain words

### Providers and profiles

A provider is the company and subscription that answers your AI requests — Anthropic's Claude plan, z.ai's GLM plan, or Moonshot's Kimi plan. Each is its own paid plan with its own allowance. A profile is a small saved file with the connection details for one provider; each file becomes one choice on the switch. Anthropic needs no file — it is the built-in default that gephyra leaves untouched. GLM and Kimi have ready-made profiles in this guide and their allowance numbers show in the meter; any other Anthropic-compatible service (one that speaks the same request format Claude Code already uses) works too — it just shows no usage numbers. [Provider setup](#provider-setup) walks through creating the files.

### When a switch takes effect

A switch applies to the **next new conversation** you start in the project. Every conversation keeps the provider it started on, so nothing you already have open changes hands mid-thought, and no window reload is ever needed. While an answer is being written, the busy gate blocks switching — gephyra watches the conversation and holds the switch until the response finishes; forcing a switch anyway asks for your confirmation first.

### Open conversations move too

When you switch, the open conversations gephyra is tracking close and reopen by themselves under the new provider — same transcript, one brief flicker, and the tab you were on gets focus back. A conversation that is mid-response is never interrupted; it keeps its old provider until you close it. Tabs gephyra could not identify (for example, ones open since before it started) simply move to the new provider once you close and resume them. To continue any conversation on the other provider yourself, resume it from Claude Code's own list of past conversations — the transcript carries over natively, and nothing is copied anywhere.

### Safe by design

Gephyra is a **supervisor, not a fork** — it doesn't replace or modify the official Claude Code extension; that extension stays untouched and does all the real work. Gephyra only sets one official Claude Code setting and hands the program its connection details when it starts (documented environment variables — nothing hidden). By default it never intercepts your traffic (what you send and receive) and never touches your sign-in. There are two narrow opt-ins, both off by default: the [live Claude usage readout](#usage-readouts) (macOS only) and the [vision fallback proxy](#settings-reference) — a proxy here being a small relay on your own computer that passes your requests along. And gephyra fails open: if it is broken, misconfigured, or deleted, Claude Code keeps working as if gephyra were never installed. The full mechanics are in [Under the hood](#under-the-hood) and the [Disclaimer](#disclaimer).

## Install

From a marketplace:

- **Cursor / VSCodium** — search **"gephyra"** in the Extensions panel
  (served from [Open VSX](https://open-vsx.org/extension/alkisyuv/gephyra)),
  or `cursor --install-extension alkisyuv.gephyra`.
- **VS Code** — install from the
  [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=alkisyuv.gephyra),
  or `code --install-extension alkisyuv.gephyra`.

Or build from source:

```bash
git clone https://github.com/triartleet/gephyra
cd gephyra
pnpm install
pnpm build
pnpm dlx @vscode/vsce package --no-dependencies
# Cursor:
cursor --install-extension gephyra-*.vsix   # or: code --install-extension …
```

Requires the official **Claude Code** extension, macOS or Linux (the shim is
POSIX sh — Windows would need a different wrapper), and pnpm/Node 20.

## Setup

1. **Configure the wrapper.** On first activation gephyra offers to point
   `claudeCode.claudeProcessWrapper` at its shim (a stable copy under
   `~/.config/gephyra/`, refreshed automatically on every activation).
   Decline and gephyra stays inert. This is a **global** setting — every
   window routes CLI spawns through the shim; on the Anthropic default the
   shim is a pure passthrough.
2. **Add provider profiles.** Create `~/.config/gephyra/<name>.env`
   files — see [Provider setup](#provider-setup) for the documented `glm.env`
   and `kimi.env` blocks. Each file becomes a provider in the switch; no
   files → the switch reports there's nothing to switch to.
3. **(Optional) Feed the Claude usage readout.** Claude Code only hands
   `rate_limits` to statusline scripts, so gephyra reads a tee of that
   payload. If you use a custom statusline, add this after it reads stdin
   (fail-safe — it can never break the status line itself):

   ```bash
   # after: input=$(cat)
   {
     gephyra_dir="$HOME/.config/gephyra"
     mkdir -p "$gephyra_dir" &&
       printf '%s' "$input" >"$gephyra_dir/statusline-last.json.tmp" &&
       mv -f "$gephyra_dir/statusline-last.json.tmp" "$gephyra_dir/statusline-last.json"
   } 2>/dev/null || true
   ```

   Without this, the Claude column shows why it's unavailable; everything
   else works.
4. **(Optional) Live Claude usage in the panel.** The statusline feed only
   updates from terminal sessions, so panel-only use shows a staleness age
   instead of a frozen number. To poll usage directly, set
   **`gephyra.anthropicLiveUsage: true`** (macOS only). Gephyra *reads* the
   access token Claude Code keeps in the Keychain and queries the usage
   endpoint with it — read-only, and it never refreshes or writes that
   credential (refreshing rotates it and would log the CLI out). While the
   stored token is momentarily expired the readout falls back to the
   statusline feed until Claude Code renews it on its next turn. If the
   session itself has lapsed, run **`Gephyra: Re-login Anthropic`**,
   which runs `claude login` and stores a fresh token gephyra then reads.
5. **(Optional) Vision on GLM/Kimi via the proxy.** See
   [Vision on GLM/Kimi (opt-in proxy)](#vision-on-glmkimi-opt-in-proxy) —
   off by default, and only worth setting up if your provider's gateway
   mangles images.

## Provider setup

Profiles live at `~/.config/gephyra/<name>.env` — strict `KEY=value`
lines, parsed not sourced, never committed anywhere.

### GLM (z.ai Coding Plan)

`glm.env`, per z.ai's Claude Code docs:

```bash
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=your-coding-plan-key
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1m]
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2[1m]
ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4.7
ANTHROPIC_SMALL_FAST_MODEL=glm-4.7
```

### Kimi Code (Moonshot)

`kimi.env`, per Moonshot's Kimi Code → Claude Code docs. Their endpoint does
**not** remap Claude model names, so every slot var is pinned; Tool Search
isn't supported on their side. See the Kimi bullet in
[Limitations & caveats](#limitations--caveats) for what's validated and
what's still open.

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

### Any other Anthropic-compatible endpoint

Any `~/.config/gephyra/<name>.env` file is a provider — drop the file
and it appears in the switch. Same rules: strict `KEY=value`, parsed not
sourced, never committed. Unknown endpoints work fully but show no usage
numbers in the status bar. A profile that omits the model-tier vars inherits
its `/model` labels from `glm.env` — the full rule is in
[Under the hood](#under-the-hood).

### Vision on GLM/Kimi (opt-in proxy)

Some provider gateways mangle pasted images — z.ai GLM did in mid-2026
(served a fixed wrong picture instead of yours) until it repaired its
`analyze_image` tool on 2026-07-31, so GLM vision currently works natively.
This proxy is the fallback for if that regresses, or for another provider
that mangles images: to keep text and code on GLM while routing image turns
to Anthropic, put a pay-as-you-go Anthropic key in
`~/.config/gephyra/anthropic-vision.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-your-payg-key
# optional — override the vision model from the setting:
# GEPHYRA_VISION_MODEL=claude-haiku-4-5-20251001
```

then set **`gephyra.visionProxy: true`**. The vision model is the
**`gephyra.visionModel`** setting (default `claude-sonnet-5`; set it to
e.g. `claude-haiku-4-5-20251001` for cheaper vision). Gephyra starts a
localhost proxy: image turns route to Anthropic under your PAYG key (cents
per image, billed to that key — your Claude subscription quota is
untouched), while everything else stays on the provider. Off by default;
off ⇒ nothing is proxied. The port is `gephyra.visionProxyPort`
(default 4399, shared across windows). Logs route to
`~/.config/gephyra/vision-proxy.log`.

## Everyday use

### Switching providers

Click the **`⇄`** status-bar item to switch the current project: with two
providers it flips straight to the other one, with three or more it opens a
picker showing each provider's 5-hour usage. Then start a **new
conversation** (the toast offers it) — an open conversation keeps the
provider it started on, by design. To continue a conversation on the other
provider, resume it from Claude Code's session list (Claude Code calls a
saved conversation a *session*); the transcript carries over natively.

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

### Beam a session to your phone (Remote Control)

The extension UI can't enable Anthropic's Remote Control, but the session
store is shared — so gephyra can hand your active session to a terminal that
has it. Before stepping away, run
**`Gephyra: Beam session to phone (Remote Control)`** from the command
palette. Gephyra resumes the project's active session in an integrated
terminal as
`claude --resume <id> --remote-control <name> --permission-mode bypassPermissions`
— permission prompts bypassed so the away-run doesn't stall on them —
under the project's provider env (the first beam may ask you to pair with
your Claude account). The session then shows up in the Claude iOS/Android
app and at claude.ai/code, mirrored live — answer its questions, send the
next step, switch models with `/model` — while execution stays on your
machine. Beaming is busy-gated like the switch. If the extension
conversation for that session is still open, close it: two surfaces replying
to one session will fork it. Remote Control itself is an Anthropic research
preview.

To come back, `/exit` the beamed terminal (Remote Control ends with the
process), then resume the session from the Claude panel's **local** session
list — a fresh resume re-reads the whole transcript, phone turns included
(a round trip verified live). Don't reopen the old conversation tab: it
restores the stale pre-beam head.

## Usage readouts

The status item shows every provider's 5-hour **and weekly** windows plus
the next 5-hour reset, inline:

```text
⇄ Claude │ C 28%/82% ↻14:00 · G 1%/40% ↻15:30
```

The tooltip adds plan tiers and reset times. The item takes the warning tint
when the active provider's 5-hour window passes 80%.

Profiles get a usage adapter picked by their base URL's hostname: z.ai
profiles query the GLM Coding Plan quota endpoint, kimi.com profiles query
the Kimi Code usage endpoint (community-documented — parsed defensively,
degrades to "usage unavailable" on surprises), other endpoints show no
numbers.

The Claude side defaults to the `rate_limits` payload Claude Code hands to
statusline scripts, teed to a file (setup step 3) — no credential handling.
That feed only updates from terminal sessions, so past 30 minutes the
readout is marked "as of HH:MM" rather than showing a frozen number. With
**`gephyra.anthropicLiveUsage`** on (opt-in; macOS only), the Claude side
instead reads Claude Code's stored access token from the Keychain and polls
the usage endpoint directly, so the bar stays fresh in the panel too. The
read is strictly read-only — gephyra never refreshes or rewrites that
credential, because refreshing rotates it and logs the CLI out. It falls
back to the statusline feed on any miss, including the windows where the
stored token is expired and the CLI hasn't yet renewed it.

## Settings reference

| Setting | Default | What it does |
| --- | --- | --- |
| `gephyra.quietWindowMs` | `2500` | How long the transcript must be silent before a session counts as idle. |
| `gephyra.switchToast` | `true` | Post-switch notification with the [New conversation] shortcut. Off: the status-bar label change is the only confirmation. Turn off once the handoff is muscle memory. |
| `gephyra.restartCliOnSwitch` | `true` | After a switch, respawn CLI processes under the new provider — details below. |
| `gephyra.anthropicLiveUsage` | `false` | Poll live Claude usage with the access token Claude Code stores in the Keychain (read-only — never refreshed) instead of the statusline feed. macOS only; falls back on any miss. |
| `gephyra.visionProxy` | `false` | Opt-in localhost proxy routing image-bearing turns to Anthropic pay-as-you-go. Off ⇒ nothing is proxied. |
| `gephyra.visionProxyPort` | `4399` | The vision proxy's localhost port (shared across windows). |
| `gephyra.visionModel` | `"claude-sonnet-5"` | Claude model for the vision leg; overridable per provider via `GEPHYRA_VISION_MODEL` in the env file. |

**`restartCliOnSwitch` in detail:** after a switch, gephyra ends this
window's idle Claude Code CLI process so the next conversation respawns
under the new provider and `/model` shows its tier labels without a window
reload (the Claude extension otherwise reuses one CLI process per window,
freezing the old provider's env until reload). Processes backing a
still-open conversation are ended only after that conversation closes, so
no "process exited" error ever appears in the panel. Open conversations
move with the switch: gephyra tracks which session each Claude tab hosts
and, on switch, closes and reopens every tracked tab on its own session —
fresh spawns under the new provider, `/model` tiers correct immediately,
each tab back in its original column with focus returning to the one you
were on (tabs flicker once). A conversation that is mid-response is never
interrupted — it keeps its old provider until you close it. Tabs gephyra
could not identify (open since before activation, ambiguous birth) keep
the old behavior: they move to the new provider when closed and resumed.

Palette commands:

| Command | Title |
| --- | --- |
| `gephyra.toggle` | Gephyra: Switch provider for this project (Claude ⇄ GLM ⇄ …) |
| `gephyra.setupWrapper` | Gephyra: Configure Claude Code process wrapper |
| `gephyra.beam` | Gephyra: Beam session to phone (Remote Control) |
| `gephyra.loginAnthropic` | Gephyra: Re-login Anthropic (run claude login) |

## Under the hood

Validated live against Claude Code extension 2.1.220 (see
[DECISIONS.md](DECISIONS.md) for the decision record, including the approaches
that were tried and reverted).

- **Process-wrapper shim.** Gephyra points `claudeCode.claudeProcessWrapper`
  (an official extension setting) at a small POSIX-sh shim. Every time the
  extension launches a Claude CLI process, the shim reads gephyra's
  per-project state and either execs the real binary clean (Anthropic) or
  with that provider's env profile injected. Each new conversation is its
  own CLI process, which is why the switch applies without a reload. On any
  doubt (missing state, unreadable config, provider endpoint down) the shim
  execs the real CLI untouched and the usage rows show the reason instead
  of erroring.
- **Per-project state** — `~/.config/gephyra/state.json` maps workspace
  path → provider name (plus a `default`). `anthropic` is reserved for the
  clean passthrough; every other name means "inject `<name>.env`". The shim
  resolves the project from the spawned process's cwd, which is the
  workspace folder (VS Code's name for a project).
- **Busy detection** — gephyra finds the project's live session via Claude
  Code's session registry (`~/.claude/sessions/<pid>.json`), then classifies
  busy/idle from the transcript tail (including nested subagent activity).
  Long silent tool runs read as busy — the safe direction — and a 30-minute
  staleness escape stops a dead session from gating forever.
- **Tier-label fallback** — a provider profile that omits the
  `ANTHROPIC_DEFAULT_<TIER>_MODEL[_NAME]` vars inherits them from `glm.env`
  (the reference mapping) so `/model` shows real names instead of falling
  through to built-in Anthropic ids. Connection vars are never inherited, and
  a profile that sets its own tiers (like `kimi.env`) is untouched.
- **Vision proxy (opt-in)** — when on, gephyra hosts a localhost HTTP server
  and the wrapper points the CLI at `http://127.0.0.1:<port>/<provider>`
  instead of the provider directly. The proxy inspects each `/v1/messages`
  request: an image-bearing turn — or a tool-loop a Claude image turn started
  — goes to `api.anthropic.com` under a pay-as-you-go key with a Claude model;
  everything else forwards to the provider verbatim (original auth, untouched).
  The routing is stateless and only looks at the last message, so a plain text
  follow-up returns the conversation to GLM immediately. It fails open: no
  creds, no proxy URL recorded in the state file, or proxy unreachable ⇒ the
  wrapper injects the provider env directly, so Claude Code never breaks
  because of it.

## Debugging

`touch ~/.config/gephyra/debug-on` (or set `GEPHYRA_DEBUG=1` in
the spawn env) makes the shim log its argv/cwd/provider decision to
`~/.config/gephyra/debug.log` (size-capped). `GEPHYRA_GLM_ENV`
still overrides the glm.env path (back-compat from the glm-only era; other
profiles have no override).

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
  after switching. Gephyra deliberately never touches model choice.
- **GLM image input was broken (z.ai-side) — repaired upstream 2026-07-31;
  opt-in vision proxy retained as a fallback.** In mid-2026 z.ai's gateway
  converted an attached image to a hosted URL and routed it through its own
  `analyze_image` tool, which returned one fixed wrong image regardless of
  what you sent (verified against Claude Code 2.1.220). z.ai fixed that tool on
  2026-07-31 (verified on two images), so GLM vision works natively again. The
  opt-in **`gephyra.visionProxy`** (with an `anthropic-vision.env`, see
  [the vision proxy setup](#vision-on-glmkimi-opt-in-proxy)) is kept — off by default
  — for if z.ai regresses: image turns route to Anthropic pay-as-you-go while
  text and code stay on GLM, spending no subscription quota. With the proxy
  off, the other fallback is to switch the project to Anthropic for vision
  (those turns run on your Claude subscription quota). Re-test GLM vision
  after a z.ai update.
- **Kimi: the pay-as-you-go leg is validated live** (Moonshot Open
  Platform endpoint, env contract, model-slot pinning, real CLI turn served
  by `kimi-k3`); the **Kimi Code plan endpoint and its usage readout are
  not yet** — new Kimi Code subscriptions were paused for capacity when
  this shipped. Their endpoint has documented gaps you should expect
  in-session: WebFetch is broken, Tool Search must stay disabled, prompt
  caching is Kimi's own implicit kind. `/model` relabels to Kimi names
  **only in a conversation started under Kimi** (see *Switching models*);
  an Anthropic-started one keeps Claude names. `/status` is the truth
  surface. The usage endpoint is community-documented; if its shape shifts,
  the Kimi column degrades to "usage unavailable" rather than breaking
  anything.
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
  Gephyra never flips the "Enable Remote Control for all sessions" setting —
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

## Disclaimer

Not affiliated with Anthropic, Z.ai, or Moonshot AI. By default gephyra never
proxies or intercepts provider traffic and never touches OAuth flows — it only
sets an official extension setting and injects documented environment
variables, so each provider is consumed exactly as its subscription intends.
The one scoped exception is the opt-in vision proxy
(`gephyra.visionProxy`, off by default): when enabled it runs a localhost
pass-through that forwards your own traffic verbatim to your configured
provider, redirecting only image-bearing turns to Anthropic under a
pay-as-you-go key you provide — it rewrites nothing but the model field on
those turns, inspects or stores no other content, and touches no OAuth flow.
Claude Code is a product of Anthropic, PBC; use of each provider is governed
by its own terms.

## License

[MIT](LICENSE)
