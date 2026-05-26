---
description: Stream or peek at an in-progress (or completed) OpenCode session's events.
argument-hint: "[session-id] [--follow] [--lines N] [--since ms] [--reasoning] [--raw] [--json]"
allowed-tools: Bash(node:*)
---

The user typed: `$ARGUMENTS`

Parse this into tokens (an optional session id followed by flags) and invoke:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" tail <parsed tokens>
```

If the user typed nothing, run `oc.mjs tail` with no args — that tails the latest active job in this CC session. For the full flag list, run `/oc:tail --help`.

Output rules:
- Pass the digest to the user verbatim — it's already terse.
- If the session is still running and `--follow` wasn't passed, mention the `--follow` hint.
- For `--json` or `--raw`, just relay the output.
