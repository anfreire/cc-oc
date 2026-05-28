---
description: Stream or peek at an opencode session's events.
argument-hint: "<session-id> [--follow] [--events N]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" tail <session-id> [--follow] [--events N]
```

## Arguments

- `session-id` (required) — the id of an opencode session (e.g. from `oc:sessions` or the output of sucessfull `oc:spawn`).
- `--follow` (optional) — block until the opencode process exits or bash times out, streaming events as they come in. If not set, only the most recent events are shown (see `--events`).
- `--events <N>` (optional) — how many recent events to show (default: 10).
