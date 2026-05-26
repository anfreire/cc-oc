---
description: Cancel one or all running OpenCode sessions spawned by this plugin.
argument-hint: "<session-id> | --all [--workspace] [--json]"
allowed-tools: Bash(node:*)
---

The user typed: `$ARGUMENTS`

Parse this into tokens (a session id or `--all` with optional flags) and invoke:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" cancel <parsed tokens>
```

Cancellation is best-effort: `opencode session abort` first, then SIGTERM to any tracked PID, then the ledger entry is marked `cancelled`. `--all` cancels every running session in this CC session; add `--workspace` to widen to the current workspace. For the full flag list, run `/oc:cancel --help`.

Output rules:
- Relay output verbatim. Surface how many sessions were cancelled.
- Do not chain follow-up actions (no `/oc:tail`, no `/oc:sessions`) unless the user asks.
