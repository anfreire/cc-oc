---
description: Cancel a running opencode session.
argument-hint: "<session-id>"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" cancel <session-id>
```

`<session-id>` is a full id or unique prefix. Best-effort abort; a session that already finished is a no-op.
