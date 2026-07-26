# CC-GG-bridgy

A tiny Cursor/VS Code companion extension that adds the one thing the official
Claude Code extension doesn't have: a **provider switch**. One status-bar
button flips your next Claude Code session between **Anthropic (Claude
subscription)** and **z.ai (GLM Coding Plan)** — same extension UI, same
session history, both directions. It also shows **both providers' 5-hour
usage** side by side, right in the status bar.

```text
⇄ Claude · C 28% · G 1%
```

It is a **supervisor, not a fork**: the official Claude Code extension stays
untouched and does all the real work. Bridgy only decides which provider the
CLI process talks to at spawn time, gates switching on "no answer pending",
and walks you through resuming the conversation on the other side.

Validated live against Claude Code extension 2.1.220 (see
[DESIGN.md](DESIGN.md) for the design record and the spike evidence).

## Features

- **Per-project provider toggle** — one workspace can run GLM while every
  other window stays on Anthropic. Click the status-bar item to switch; the
  next new conversation in that project uses the new provider. No window
  reload, no settings churn.
- **Dual usage readout** — the status item shows both providers' 5-hour
  windows inline (`C 28% · G 1%`); the tooltip adds the weekly windows,
  reset times, and your GLM plan tier. The item takes the warning tint when
  the active provider's 5-hour window passes 80%.
- **Busy gate** — switching is gated while a response looks in-flight, so a
  toggle can't corrupt an open turn; a forced switch asks for confirmation.
- **Native session handoff** — transcripts are provider-agnostic and shared,
  so after a toggle you just start a new conversation and resume the previous
  session from Claude Code's own session list. Nothing is copied or proxied.
- **Fail-open by design** — on any doubt (missing state, unreadable config,
  provider endpoint down) the wrapper execs the real CLI untouched and the
  usage rows show the reason instead of erroring. Claude Code keeps working
  even if bridgy is misconfigured or deleted.

## How it works

- **Process-wrapper shim.** Bridgy points `claudeCode.claudeProcessWrapper`
  (an official extension setting) at a small POSIX-sh shim. Every time the
  extension launches a Claude CLI process, the shim reads bridgy's
  per-project state and either execs the real binary clean (Anthropic) or
  with the GLM env injected (z.ai). Each new conversation is its own CLI
  process, which is why the toggle applies without a reload.
- **Per-project state** — `~/.config/cc-gg-bridgy/state.json` maps workspace
  path → `anthropic | glm` (plus a `default`). The shim resolves the project
  from the spawned process's cwd, which is the workspace folder.
- **GLM credentials** — `~/.config/cc-gg-bridgy/glm.env` (never committed;
  strict `KEY=value` lines, parsed not sourced). Per z.ai's Claude Code docs:

  ```bash
  ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
  ANTHROPIC_AUTH_TOKEN=your-coding-plan-key
  ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1m]
  ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2[1m]
  ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4.7
  ANTHROPIC_SMALL_FAST_MODEL=glm-4.7
  ```

- **Busy detection** — bridgy finds the project's live session via Claude
  Code's session registry (`~/.claude/sessions/<pid>.json`), then classifies
  busy/idle from the transcript tail (including nested subagent activity).
  Long silent tool runs read as busy — the safe direction — and a 30-minute
  staleness escape stops a dead session from gating forever.
- **Usage sources** — the GLM side queries the Coding Plan quota endpoint
  with your key. The Claude side reads the `rate_limits` payload Claude Code
  itself hands to statusline scripts, teed to a file (see setup step 3) — no
  credential handling at all.

## Install

Not on any marketplace (yet) — build from source:

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
2. **Add GLM credentials.** Create `~/.config/cc-gg-bridgy/glm.env` as shown
   above. No file → the GLM side simply reports itself unavailable.
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

Click **`⇄ Claude`** / **`⇄ GLM`** in the status bar to toggle the current
project. Then start a **new conversation** (the toast offers it) — an open
conversation keeps the provider it started on, by design. To continue a
conversation on the other provider, resume it from Claude Code's session
list; the transcript carries over natively.

Settings: `ccGgBridgy.quietWindowMs` — how long the transcript must be
silent before a session counts as idle (default 2500 ms).

Debugging: `touch ~/.config/cc-gg-bridgy/debug-on` (or set
`CC_GG_BRIDGY_DEBUG=1` in the spawn env) makes the shim log its
argv/cwd/provider decision to `~/.config/cc-gg-bridgy/debug.log`
(size-capped). `CC_GG_BRIDGY_GLM_ENV` overrides the glm.env path.

## Limitations & caveats

- **A fresh GLM conversation may open on the small/fast model slot** (e.g.
  `glm-4.7`) depending on the panel's sticky model choice — check `/model`
  after switching. Bridgy deliberately never touches model choice.
- **Claude usage freshness rides on terminal use.** The extension UI doesn't
  run statusline scripts, so the Claude column updates when a terminal
  `claude` session makes a turn; past 30 minutes it's marked "as of HH:MM".
  The GLM column is always live.
- **The busy heuristic reads safe, not perfect.** Long silent tool
  executions and permission prompts read as busy; the forced-switch confirm
  covers the rest.
- **Closed-source churn.** Anthropic can change the wrapper setting or spawn
  path in any release (the extension auto-updates). The shim fails open, so
  the failure mode is "toggle silently does nothing", never a broken Claude
  Code — re-verify after major extension updates.
- Cosmetics: the extension UI may render Claude model names in some places
  while under GLM; the status bar is the truth surface for the provider.

## Roadmap

- Button in the Claude panel's title bar beside the status-bar item.
- Auto-resume: open an integrated terminal running
  `claude --resume <newest-session-id>` under the target env.
- Per-session provider badges in the tooltip (from transcript `model`
  fields).
- Named env profiles instead of the fixed `anthropic | glm` pair — a
  universal per-project provider switch for any Anthropic-compatible
  endpoint.

## Disclaimer

Not affiliated with Anthropic or Z.ai. Bridgy never proxies or intercepts
provider traffic and never touches OAuth flows — it only sets an official
extension setting and injects documented environment variables, so each
provider is consumed exactly as its subscription intends. Claude Code is a
product of Anthropic, PBC; use of each provider is governed by its own
terms.

## License

[MIT](LICENSE)
