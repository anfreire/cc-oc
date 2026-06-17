---
description: Stream or peek at an opencode session's events.
argument-hint: "<session-id> [--follow] [--events N]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" tail <session-id> [--follow] [--events N]
```

`tail` shows the session's **event trace** (tool calls, model text, errors) — for watching progress or debugging. To get the agent's final answer, use `oc:wait`.

## Arguments

- `session-id` (required) — the id of an opencode session (e.g. from `oc:sessions` or the output of successful `oc:spawn`).
- `--follow` (optional) — block until the opencode process exits or bash times out, streaming events as they come in.
- `--events <N>` (optional) — show the last N events (default 1). Counts *renderable* events, so structural events like `step_finish` never make it come back empty. Combinable with `--follow`.
