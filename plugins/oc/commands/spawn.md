---
description: Spawn an opencode task. Read-only and foreground by default. Add --bg to detach, --write to allow file writes.
argument-hint: "[flags] -- <prompt>"
allowed-tools: Bash(node:*)
---

`$ARGUMENTS` is the full flag-and-prompt string. Pass the prompt after `--`.

Examples:

```
/oc:spawn -- "Review the staged diff for security issues"
/oc:spawn --bg -- "Trace how config flows from CLI flag to runtime"
/oc:spawn --write -- "Apply the smallest fix that makes test foo pass"
/oc:spawn --exclude-mcp playwright -- "Quick scan, no browser MCP needed"
```

For the full flag list, run `/oc:spawn --help`.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" spawn --stdin <<< "$ARGUMENTS"
```

Output rules:
- Foreground: stream the digest lines as they arrive; show the final assistant text last.
- Background: print the started-job message + the `/oc:tail` hint and stop. Do not block.
- Do not paraphrase or summarize opencode's response. Relay verbatim.
- If opencode errors out, surface the stderr and stop. Do not retry silently.
