# AGENTS.md

Operating contract for AI agents working in **gephyra**. One source of truth — most agents
(Claude Code, Codex, Cursor, Copilot, Gemini, …) read this file natively. Kept true by
[etymd](https://www.npmjs.com/package/etymd): the commands, paths, and claims below are audited
against the actual repo — update this file when the repo changes, or `etymd audit` will tell you.

## What this project is

A Cursor/VS Code companion extension for the Claude Code extension: a per-project provider
switch (Anthropic ⇄ named env profiles — GLM, Kimi, any Anthropic-compatible endpoint)
implemented as a wrapper shim around the Claude binary, plus a status bar with per-provider
usage readout and a `beam` command that hands the active session to Anthropic Remote Control
for phone/web reach. Built for daily multi-provider use; published publicly (MIT)
for anyone on the same setup. `DECISIONS.md` is the decision record; `README.md` is the
user-facing guide — keep that split.

## Stack

- **Shape:** pnpm workspace, package manager **pnpm**.
- **Frameworks:** see package.json.
- **CI:** none detected.

## Working rules

- **Reuse-first.** Before writing any new helper/component/type: check the map below and the
  surrounding code — a "new" thing usually exists.
- **Minimal diffs.** Never touch files outside the task's scope.
- **DECISIONS.md is load-bearing.** Read its "Locked decisions", "Failed approaches" and
  "Non-goals" sections before any non-trivial change; do not re-open a locked decision without
  the maintainer, and never re-attempt anything under "Failed approaches". Core invariants: the
  wrapper is a fail-open supervisor shim (never a fork, never mutates settings files), the
  toggle switches providers not models (never pin a model), and usage polling must never block.
- **No test suite.** `pnpm typecheck` and `pnpm build` are the only automated gates; verify
  behavior manually in the Extension Development Host before calling a change done.
- **Never commit or push unasked.** The maintainer drives version control; commits stay unattributed
  (no Co-authored-by / generated-with trailers).
- **Public repo.** Commit author is the personal identity already set in local git config —
  never a corporate one. Publishing exposes ALL history, not just the current tree, so no
  tracked file or commit message may carry: absolute paths, hostnames or other machine and
  environment detail; employer, client or internal project names and ticket identifiers;
  identity or credential configuration written into prose (author metadata belongs in
  `LICENSE` and `package.json`); the names of the maintainer's other projects; competitive
  positioning against other tools; or internal deliberation and provenance. The test:
  *would this line make sense, and be safe, read by a stranger who knows nothing about the
  maintainer or their other work?* A pre-commit content gate enforces this where installed
  (`.githooks/pre-commit`) — a backstop, not a substitute for the rule.

## Repo map

> **Advisory, not authoritative** — re-verify with `pnpm -r ls --depth -1` before
> structure-sensitive changes, and update this section in the same change that moves files.

- `src/` — 7 files
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
