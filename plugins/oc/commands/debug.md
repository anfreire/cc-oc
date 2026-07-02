---
description: Print an opencode session's status and full event trace.
argument-hint: "<session-id>"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" debug <session-id>
```

The way to inspect a session — progress, tool calls, failures — with no need to read the raw `.ndjson` log. Works the same on every session state; `<session-id>` is a full id or unique prefix. For the final answer, use `/oc:wait`.

```
session:  <id>
status:   running | done | error | cancelled
activity: 5s ago

[+0:00] model: Scanning the repo.
[+0:02] tool: bash npm test
[+0:41] model: Two tests fail.
  Both compare floats without a tolerance.
```

Reading the trace:

- A flush-left `[+m:ss]` line is an event; indented lines continue the event above. `(no events)` = empty or pruned log.
- Errors stay visible even when opencode recovered from them (e.g. a model fallback); only an unrecovered error at the end makes `status: error`.
- `running` with stale `activity` and no trailing error = stalled, usually a provider usage limit — see `reference/recovery.md`.
