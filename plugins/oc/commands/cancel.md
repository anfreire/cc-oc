---
description: Cancel one or all running OpenCode sessions spawned by this plugin.
argument-hint: "<session-id> | --all [--workspace] [--json]"
allowed-tools: Bash(node:*)
---

`$ARGUMENTS` accepts a session id (full or unique prefix), or `--all` to cancel every running session in this CC session (add `--workspace` to widen to the current workspace).

Cancellation is best-effort: `opencode session abort` first, then SIGTERM to any tracked PID, then the ledger entry is marked `cancelled`.

For the full flag list, run `/oc:cancel --help`.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" cancel --stdin <<< "$ARGUMENTS"
```

Output rules:
- Relay output verbatim. Surface how many sessions were cancelled.
- Do not chain follow-up actions (no `/oc:tail`, no `/oc:sessions`) unless the user asks.
