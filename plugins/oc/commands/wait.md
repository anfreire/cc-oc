---
description: Block until an opencode session finishes, then print its final answer.
argument-hint: "<session-id>"
allowed-tools: Bash(node:*), Monitor
---

Run it under Monitor with `persistent: true` — a notification arrives when the session ends.

```
Monitor({
  command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" wait <session-id> 2>&1',
  description: "opencode session <session-id>",
  persistent: true,
})
```

`<session-id>` is a full id or unique prefix (from `/oc:spawn` or `/oc:sessions`).

Prints the final answer on stdout (exit 0), error or cancellation on stderr (exit 1). The `2>&1` is required — `wait` reports errors and cancellations on stderr — without it a failed session ends the watch with exit 1 and no message.
