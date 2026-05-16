---
description: Stream or peek at an in-progress (or completed) OpenCode session's events.
argument-hint: "[session-id] [--follow] [--lines N] [--since ms] [--reasoning] [--raw] [--json]"
allowed-tools: Bash(node:*)
---

`$ARGUMENTS` accepts a session id (full or unique prefix). With no arg, tails the latest active job in this CC session.

For the full flag list, run `/oc:tail --help`.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" tail --stdin <<'__OC_ARGV__'
$ARGUMENTS
__OC_ARGV__
```

Output rules:
- Pass the digest to the user verbatim — it's already terse.
- If the session is still running and `--follow` wasn't passed, mention the `--follow` hint.
- For `--json` or `--raw`, just relay the output.
