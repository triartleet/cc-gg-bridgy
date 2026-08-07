# Roadmap

What's next for Gephyra, in order of intent. This list is pruned, reordered and rewritten
freely — the decisions behind deferrals, and the approaches already ruled out, live in
[DECISIONS.md](DECISIONS.md).

## Next

- **Alt-provider remote reach**: official Remote Control is Anthropic-only (the CLI
  disables it whenever `ANTHROPIC_BASE_URL` is set), so investigate remote control for
  sessions served by other providers — open-source bridge projects, or other angles.

## Later

- Live-validate the Kimi leg against a real Kimi Code subscription (auth var, model slots,
  usage response shape).
- A button in the Claude panel's title bar beside the status-bar item.
- Per-session provider badges in the tooltip (from transcript `model` fields).
