---
description: List or inspect OpenCode sessions spawned by this plugin.
argument-hint: "[session-id] [--all] [--json]"
allowed-tools: Bash(node:*)
---

The user typed: `$ARGUMENTS`

Tokenize that string (whitespace-separated, respecting quoted substrings as single tokens), then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" sessions <tokens>
```

`oc.mjs sessions` accepts an optional session id (full or unique prefix) as the first positional, plus flags. No prompt body. With zero tokens, it lists current-CC-session jobs.

## Example parses

| User input | Composed argv |
|---|---|
| `/oc:sessions` | `node oc.mjs sessions` |
| `/oc:sessions --all` | `node oc.mjs sessions --all` |
| `/oc:sessions ses_abc` | `node oc.mjs sessions ses_abc` |
| `/oc:sessions --all --json` | `node oc.mjs sessions --all --json` |

For the full flag list, run `/oc:sessions --help`. To cancel a session, use `/oc:cancel`.

## Output rules

- Relay the output verbatim.
