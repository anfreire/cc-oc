---
description: Cancel one or all running OpenCode sessions spawned by this plugin.
argument-hint: "<session-id> | --all [--workspace] [--json]"
allowed-tools: Bash(node:*)
---

The user typed: `$ARGUMENTS`

Tokenize that string (whitespace-separated, respecting quoted substrings as single tokens), then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" cancel <tokens>
```

`oc.mjs cancel` takes either a session id (full or unique prefix) as the first positional, or `--all` to cancel every running session in this CC session. Add `--workspace` to widen `--all` to all sessions in the current workspace. No prompt body.

## Example parses

| User input | Composed argv |
|---|---|
| `/oc:cancel ses_abc` | `node oc.mjs cancel ses_abc` |
| `/oc:cancel --all` | `node oc.mjs cancel --all` |
| `/oc:cancel --all --workspace` | `node oc.mjs cancel --all --workspace` |
| `/oc:cancel ses_abc --json` | `node oc.mjs cancel ses_abc --json` |

Cancellation is best-effort: `opencode session abort` first, then SIGTERM to any tracked PID, then the ledger entry is marked `cancelled`. For the full flag list, run `/oc:cancel --help`.

## Output rules

- Relay output verbatim. Surface how many sessions were cancelled.
- Do not chain follow-up actions (no `/oc:tail`, no `/oc:sessions`) unless the user asks.
