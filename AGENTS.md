# AGENTS.md

Operating contract for AI agents working in **cc-gg-bridgy**. One source of truth — most agents
(Claude Code, Codex, Cursor, Copilot, Gemini, …) read this file natively. Kept true by
[etymd](https://www.npmjs.com/package/etymd): the commands, paths, and claims below are audited
against the actual repo — update this file when the repo changes, or `etymd audit` will tell you.

## What this project is

A Cursor/VS Code companion extension for the Claude Code extension: a per-project provider
switch (Anthropic ⇄ named env profiles — GLM, Kimi, any Anthropic-compatible endpoint)
implemented as a wrapper shim around the Claude binary, plus a status bar with per-provider
usage readout and a `beam` command that hands the active session to Anthropic Remote Control
for phone/web reach. Built for the owner's daily multi-provider use; published publicly (MIT)
for anyone on the same setup. `DESIGN.md` is the decision record; `README.md` is the
user-facing guide — keep that split.

## Stack

- **Shape:** pnpm workspace, package manager **pnpm**.
- **Frameworks:** see package.json.
- **CI:** none detected.

## Working rules

- **Reuse-first.** Before writing any new helper/component/type: check the map below and the
  surrounding code — a "new" thing usually exists.
- **Minimal diffs.** Never touch files outside the task's scope.
- **DESIGN.md is load-bearing.** Read its "Locked decisions" and "Non-goals" sections before any
  non-trivial change; do not re-open a locked decision without the owner. Core invariants: the
  wrapper is a fail-open supervisor shim (never a fork, never mutates settings files), the
  toggle switches providers not models (never pin a model), and usage polling must never block.
- **No test suite.** `pnpm typecheck` and `pnpm build` are the only automated gates; verify
  behavior manually in the Extension Development Host before calling a change done.
- **Never commit or push unasked.** The owner drives version control; commits stay unattributed
  (no Co-authored-by / generated-with trailers).
- **Public repo.** Commit author is the personal identity already set in local git config —
  never a corporate one.

## Repo map

> **Advisory, not authoritative** — re-verify with `pnpm -r ls --depth -1` before
> structure-sensitive changes, and update this section in the same change that moves files.

- `src/` — 5 files
- `.vscode/` — 2 files
- `media/` — 2 files
- `bin/` — 1 files

## Done =

A change is done when these are green:

- `pnpm typecheck`

## Commands

```bash
pnpm build
pnpm typecheck
```

<!-- etymd pack v1 -->
