---
description: Cancel a running opencode session.
argument-hint: "<session-id>"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" cancel <session-id>
```

Where `<session-id>` is the id of an active opencode session (e.g. from `oc:sessions` or the output of sucessfull `oc:spawn`).
