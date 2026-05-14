---
description: Cancel one or all running OpenCode sessions spawned by this plugin.
argument-hint: "<session-id> | --all [--workspace] [--json]"
allowed-tools: Bash(node:*)
---

`$ARGUMENTS`:
- `<session-id>` (full or unique prefix) → cancel that session.
- `--all` → cancel every running session in this CC session.
- `--all --workspace` → cancel every running session in the current workspace (across CC sessions).
- `--json` → machine-readable result.

Cancellation is best-effort: `opencode session abort` is invoked first to notify OpenCode's own session DB, then SIGTERM is sent to any tracked background PID, then the ledger entry is marked `cancelled`.

Run:

```bash
printf '%s' "$ARGUMENTS" | node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" cancel --stdin
```

Output rules:
- Relay output verbatim. Surface how many sessions were cancelled.
- Do not chain follow-up actions (no `/oc:tail`, no `/oc:sessions`) unless the user asks.
