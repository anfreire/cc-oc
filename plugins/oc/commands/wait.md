---
description: Block until an opencode session finishes.
argument-hint: "<session-id>"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" wait <session-id>
```

## Arguments

- `session-id` (required) — the id of an opencode session (e.g. from `oc:sessions` or the output of successful `oc:spawn`).

## Usage

- **To be notified when it finishes** — run it in the background (`run_in_background: true`); you get one notification when the session ends.
- **To block until it finishes** — run it directly.
