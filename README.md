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
  5-hour window inline (`C 28% · G 1% · K 7%`); the tooltip adds the weekly
  windows, reset times, and plan tiers. The item takes the warning tint when
  the active provider's 5-hour window passes 80%.
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
  endpoints show no numbers. The Claude side reads the `rate_limits` payload
  Claude Code itself hands to statusline scripts, teed to a file (see setup
  step 3) — no credential handling at all.

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

## Using it

Click the **`⇄`** status-bar item to switch the current project: with two
providers it flips straight to the other one, with three or more it opens a
picker showing each provider's 5-hour usage. Then start a **new
conversation** (the toast offers it) — an open conversation keeps the
provider it started on, by design. To continue a conversation on the other
provider, resume it from Claude Code's session list; the transcript carries
over natively.

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

Debugging: `touch ~/.config/cc-gg-bridgy/debug-on` (or set
`CC_GG_BRIDGY_DEBUG=1` in the spawn env) makes the shim log its
argv/cwd/provider decision to `~/.config/cc-gg-bridgy/debug.log`
(size-capped). `CC_GG_BRIDGY_GLM_ENV` still overrides the glm.env path
(back-compat from the glm-only era; other profiles have no override).

## Limitations & caveats

- **A fresh GLM conversation may open on the small/fast model slot** (e.g.
  `glm-4.7`) depending on the panel's sticky model choice — check `/model`
  after switching. Bridgy deliberately never touches model choice.
- **Kimi: the pay-as-you-go leg is validated live** (Moonshot Open
  Platform endpoint, env contract, model-slot pinning, real CLI turn served
  by `kimi-k3`); the **Kimi Code plan endpoint and its usage readout are
  not yet** — new Kimi Code subscriptions were paused for capacity when
  this shipped. Their endpoint has documented gaps you should expect
  in-session: WebFetch is
  broken, Tool Search must stay disabled, prompt caching is Kimi's own
  implicit kind, and `/model` won't list Kimi models — `/status` is the
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

Not affiliated with Anthropic, Z.ai, or Moonshot AI. Bridgy never proxies or intercepts
provider traffic and never touches OAuth flows — it only sets an official
extension setting and injects documented environment variables, so each
provider is consumed exactly as its subscription intends. Claude Code is a
product of Anthropic, PBC; use of each provider is governed by its own
terms.

## License

[MIT](LICENSE)
