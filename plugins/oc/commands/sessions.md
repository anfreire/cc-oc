---
description: List opencode sessions spawned in this Claude Code session.
argument-hint: ""
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" sessions
```

Takes no arguments. Lists every session spawned by `/oc:spawn` in the current Claude Code session, with columns:

- `session` — opencode session id
- `started` — relative time (e.g. `2m ago`)
- `status` — `running` / `done` / `error`
- `prompt` — first ~60 chars of the prompt

To peek at a session, use `/oc:tail <session-id>`
To cancel a running session, use `/oc:cancel <session-id>`.
