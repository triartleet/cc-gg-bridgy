# CC-GG-bridgy

A tiny Cursor/VS Code companion extension that adds one thing the Claude Code
extension doesn't have: a **provider switch**. One status-bar button flips the
next Claude Code session between **Anthropic (Claude subscription)** and
**z.ai (GLM Coding Plan)** — same extension UI, same session history, both
directions.

It is a **supervisor, not a fork**: the official Claude Code extension stays
untouched and does all the real work. Bridgy only decides which provider the
CLI process talks to at spawn time, gates switching on "no answer pending",
and walks you through resuming the conversation on the other side.

## How it works

- **Per-project state** — `~/.config/cc-gg-bridgy/state.json` maps workspace
  path → `anthropic | glm`. The button toggles the entry for the current
  workspace only.
- **Process-wrapper shim** — bridgy sets `claudeCode.claudeProcessWrapper`
  (an official extension setting) to `bin/cc-gg-wrapper`. Every time the
  extension launches a Claude CLI process, the shim reads the state for the
  project and either execs the real binary clean (Anthropic) or with the GLM
  env injected (z.ai). No settings churn, no window reload dependency.
- **GLM credentials** — `~/.config/cc-gg-bridgy/glm.env` (never committed;
  strict `KEY=value` lines, parsed not sourced). Per z.ai's Claude Code docs:
  `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`, `ANTHROPIC_AUTH_TOKEN`
  (the Coding Plan key), `ANTHROPIC_DEFAULT_OPUS_MODEL` /
  `ANTHROPIC_DEFAULT_SONNET_MODEL` (e.g. `glm-5.2[1m]`).
- **Busy gate** — the button disables while the active session's transcript
  (`~/.claude/projects/<slug>/*.jsonl`) shows a response in flight; a forced
  switch asks for confirmation instead of silently corrupting a turn.
- **Handoff** — sessions are already provider-agnostic JSONL in one shared
  store; the CLI's own `--resume <session-id>` is the transfer mechanism.
  After a toggle, bridgy offers **New conversation** (spawns a fresh process
  under the new provider) and points you at the session list to resume.

## Status

Alpha. The four design decisions are locked and spikes S1–S5 passed live in
a Cursor Extension Development Host on 2026-07-26 (see
[DESIGN.md](DESIGN.md) — Spike results). Nothing here proxies traffic or
touches auth flows — each provider serves its own subscription through its
own supported endpoint.

## Dev loop

```bash
pnpm install
pnpm build          # esbuild bundle → dist/extension.js
# open this folder in Cursor and F5 (Extension Development Host)
```

First activation offers to configure the wrapper setting; decline it to run
inert. `CC_GG_BRIDGY_DEBUG=1` — or, since the extension's spawn env is hard to
reach, `touch ~/.config/cc-gg-bridgy/debug-on` — makes the shim log its
argv/cwd/env decision to `~/.config/cc-gg-bridgy/debug.log` (spike S1/S3
evidence). An explicit env value overrides the flag file.
