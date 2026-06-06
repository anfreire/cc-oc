---
description: Cancel a running opencode session.
argument-hint: "<session-id>"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" cancel <session-id>
```

## Arguments

- `session-id` (required) — the id of an opencode session (e.g. from `oc:sessions` or the output of successful `oc:spawn`).
