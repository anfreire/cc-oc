---
description: List opencode sessions spawned in this Claude Code session.
argument-hint: ""
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" sessions
```

One row per session: id, activity (time of the last event), status (`running` / `done` / `error` / `cancelled`), and the session's title or prompt.
