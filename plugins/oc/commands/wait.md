---
description: Block until an opencode session finishes, then print its final answer.
argument-hint: "<session-id>"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" wait <session-id>
```

`<session-id>` is a full id or unique prefix (from `/oc:spawn` or `/oc:sessions`).

Prints the final answer on stdout (exit 0); an errored or cancelled session reports on stderr (exit 1). Usually run in the background (`run_in_background: true`) so the completion notification carries the answer — run it directly when you want to block on it now.
