---
description: Stream or peek at an in-progress (or completed) OpenCode session's events.
argument-hint: "[session-id] [--follow] [--lines N] [--since ms] [--reasoning] [--raw] [--json]"
allowed-tools: Bash(node:*)
---

`$ARGUMENTS`:
- No arg → latest active job from this CC session.
- `<session-id>` (full or unique prefix) → that session.
- `--follow` blocks until the session reaches an idle/error event (max 15 min).
- `--lines N` returns only the last N events.
- `--since <ts-ms>` filters events newer than the given timestamp.
- `--reasoning` includes thinking/reasoning lines (off by default to save tokens).
- `--raw` emits the raw NDJSON instead of a digest.
- `--json` wraps the result in a JSON envelope.

Run:

```bash
printf '%s' "$ARGUMENTS" | node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" tail --stdin
```

Output rules:
- Pass the digest to the user verbatim — it's already terse.
- If the session is still running and `--follow` wasn't passed, mention the `--follow` hint.
- For `--json` or `--raw`, just relay the output.
