---
description: List or inspect OpenCode sessions spawned by this plugin.
argument-hint: "[session-id] [--all] [--json]"
allowed-tools: Bash(node:*)
---

`$ARGUMENTS`:
- No arg → list current CC-session jobs.
- `<session-id>` → detailed snapshot of one session (full ID or unique prefix).
- `--all` → include sessions from other CC sessions in this workspace.
- `--json` → machine-readable output.

To cancel a session, use `/oc:cancel`.

Run:

```bash
printf '%s' "$ARGUMENTS" | node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" sessions --stdin
```

Output rules:
- Relay the output verbatim.
