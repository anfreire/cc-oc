---
description: Stream or peek at an in-progress (or completed) OpenCode session's events.
argument-hint: "[session-id] [--follow] [--lines N] [--since ms] [--reasoning] [--raw] [--json]"
allowed-tools: Bash(node:*)
---

The user typed: `$ARGUMENTS`

Tokenize that string (whitespace-separated, respecting quoted substrings as single tokens), then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" tail <tokens>
```

`oc.mjs tail` accepts an optional session id (full or unique prefix) as the first positional, plus flags in any order. No prompt body — `tail` reads from no stdin. With zero tokens, it tails the latest active job in this CC session.

## Example parses

| User input | Composed argv |
|---|---|
| `/oc:tail` | `node oc.mjs tail` |
| `/oc:tail --follow` | `node oc.mjs tail --follow` |
| `/oc:tail ses_abc` | `node oc.mjs tail ses_abc` |
| `/oc:tail ses_abc --follow` | `node oc.mjs tail ses_abc --follow` |
| `/oc:tail --lines 50 --since 1700000000000` | `node oc.mjs tail --lines 50 --since 1700000000000` |
| `/oc:tail --json` | `node oc.mjs tail --json` |

For the full flag list, run `/oc:tail --help`.

## Output rules

- Pass the digest to the user verbatim — it's already terse.
- If the session is still running and `--follow` wasn't passed, the tool itself prints a `(session still running; use --follow to wait)` hint; relay that too.
- For `--json` or `--raw`, just relay the output.
