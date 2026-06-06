---
description: List opencode sessions spawned in this Claude Code session.
argument-hint: ""
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" sessions
```

## Output

Lists every session spawned by `/oc:spawn` in the current Claude Code session, with columns:

- `session` — opencode session id
- `activity` — when the most recent event was emitted (e.g. `5s ago`)
- `status` — `running` / `done` / `error`
- `prompt` — first ~60 chars of the prompt

## Related commands

- `/oc:wait` — wait for a session to finish
- `/oc:tail` — peek at a session's events
- `/oc:cancel` — cancel a running session
