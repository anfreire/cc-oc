---
description: Block until an opencode session finishes, then print its final answer.
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

- **To get the answer when it finishes** — run it in the background (`run_in_background: true`); the completion notification carries the final answer.
- **To block and read the answer now** — run it directly.
