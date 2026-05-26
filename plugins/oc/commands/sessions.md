---
description: List or inspect OpenCode sessions spawned by this plugin.
argument-hint: "[session-id] [--all] [--json]"
allowed-tools: Bash(node:*)
---

The user typed: `$ARGUMENTS`

Parse this into tokens (an optional session id followed by flags) and invoke:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" sessions <parsed tokens>
```

If the user typed a session id, that's a detailed snapshot. `--all` widens scope to other CC sessions in this workspace. No args lists current-CC-session jobs. For the full flag list, run `/oc:sessions --help`. To cancel a session, use `/oc:cancel`.

Output rules:
- Relay the output verbatim.
