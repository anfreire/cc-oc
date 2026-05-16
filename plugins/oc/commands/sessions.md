---
description: List or inspect OpenCode sessions spawned by this plugin.
argument-hint: "[session-id] [--all] [--json]"
allowed-tools: Bash(node:*)
---

`$ARGUMENTS` accepts a session id for a detailed snapshot, `--all` to widen scope to other CC sessions in this workspace, or no arg to list current-CC-session jobs.

For the full flag list, run `/oc:sessions --help`. To cancel a session, use `/oc:cancel`.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" sessions --stdin <<'__OC_ARGV__'
$ARGUMENTS
__OC_ARGV__
```

Output rules:
- Relay the output verbatim.
