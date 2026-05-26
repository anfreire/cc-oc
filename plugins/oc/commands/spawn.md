---
description: Start an opencode session. Always runs detached — cc-oc exits immediately, opencode keeps running. /oc:tail to wait for the result.
argument-hint: "[flags] <prompt>"
allowed-tools: Bash(node:*)
---

The user typed: `$ARGUMENTS`

Your job: split that string into **flag tokens** + a **prompt body** using the rules below, then invoke `oc.mjs spawn` with the flags in argv and the prompt body piped on stdin via a single-quoted heredoc.

**One transport rule:** argv carries flags only; the prompt body is read from stdin. Any unknown flag or stray non-flag token in argv is an error.

**Lifecycle:** `/oc:spawn` always starts opencode detached. cc-oc returns in milliseconds with a started-session block (pid + pending session id + the four follow-up commands). opencode keeps running in its own process group, writing NDJSON events to a log file. To wait for opencode to finish, run `/oc:tail <id> --follow` next; to peek without blocking, `/oc:tail <id>`; to abort, `/oc:cancel <id>`.

## Example parses

| User input | Flags | Prompt body |
|---|---|---|
| `/oc:spawn review the staged diff for security issues` | *(none)* | `review the staged diff for security issues` |
| `/oc:spawn --write apply the smallest fix that makes test foo pass` | `--write` | `apply the smallest fix that makes test foo pass` |
| `/oc:spawn --provider opencode-go --model deepseek-v4-flash review the diff` | `--provider opencode-go --model deepseek-v4-flash` | `review the diff` |
| `/oc:spawn --continue ses_abc now add error handling to that function` | `--continue ses_abc` | `now add error handling to that function` |
| `/oc:spawn --exclude-mcp playwright quick scan, no browser needed` | `--exclude-mcp playwright` | `quick scan, no browser needed` |

The composed invocation always has this shape (heredoc terminator at column 1 in the actual bash, no indentation):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" spawn <flag tokens> <<'OC_PROMPT'
<prompt body verbatim>
OC_PROMPT
```

## Parsing user prompts into flags

When the user phrases a request naturally, translate it into flags before composing the call. The prompt body should describe the task; everything that's a knob goes in flags.

| User phrasing | Flags |
|---|---|
| "use X from Y" / "with X from Y" / "via Y's X" / "Y's X model" | `--provider Y --model X` |
| "use Y/X" (already provider/model form) | split on `/`: `--provider Y --model X` |
| "use model X" (no provider) | `--provider` and `--model` are paired — **ask the user** which provider to use rather than silently dropping the model intent. If the user genuinely wants opencode's default, they'll say so. |
| "let it edit" / "allow writes" / "give it write access" | `--write` |
| "without the X MCP" / "skip the X plugin" | `--exclude-mcp X` |
| "include the X MCP" (when globally excluded) | `--include-mcp X` |
| "continue session <id>" / "follow up on <id>" / "resume <id>" | `--continue <id>` |
| "with high reasoning" / "<tier> variant" | `--variant <name>` |
| "in directory X" / "from path X" | `--cwd X` |
| "pin the X agent" | `--agent X` |

For reasoning lines, pass `--reasoning` to `/oc:tail` — spawn itself does not stream.

**Whitespace in the user's value decides whether to look it up first.** Apply this rule per field — independently for `--provider`, `--model`, and `--agent`:

- **No whitespace in the user's value** (e.g. `deepseek-v4-flash`, `gpt-5.5`, `opencode-go`, `claude-sonnet-4-6`, `build`, `explore`): treat it as a canonical id. Pass through verbatim — do not lowercase, do not transform punctuation, do not guess. cc-oc does not pre-validate; opencode does. If opencode rejects it later, recover with the matching diagnostic (see Recovery below).
- **Whitespace in the user's value** (e.g. "deepseek v4 flash", "OpenCode Go", "the DeepSeek flash model", "the build agent", "compaction subagent"): it's a hint, not an id. **Look it up before spawning**, using the right diagnostic:
  - provider/model — whichever shape fits:
    - provider only spaced → `oc.mjs models --match "<provider hint>"`
    - model only spaced (provider given as a clean id) → `oc.mjs models --provider <id> --match "<model hint>"`
    - both spaced → `oc.mjs models --match "<combined hint>"`
  - agent — `oc.mjs agents --match "<agent hint>"`

  Show the top 1–3 candidates to the user, confirm which they meant, then spawn with the exact ids returned. Never guess the transformation yourself — token boundaries, capitalization, dots vs hyphens vary per provider/agent, so a guess can collide with the real id.

`--provider` and `--model` are paired — pass both or neither. `--continue <session-id>` resumes a prior opencode session with its full conversation history; find ids via `/oc:sessions`. For the full flag list, run `/oc:spawn --help`.

## How to parse `$ARGUMENTS`

Walk the typed string left-to-right. While the next token is a *known* flag (from the table above and `oc.mjs spawn --help`), consume it (and its value, if the flag takes one). As soon as you hit a non-flag token, **everything from that point on is the prompt body** — keep it verbatim, preserving spaces, punctuation, and casing.

The prompt body may contain `--`, `--something`, quotes, `$`, backticks — none of it gets reinterpreted, because it lands inside a single-quoted heredoc.

### Handling flag-shaped tokens

A token that *looks* like a flag (starts with `--`) is one of three things. Decide by looking at the surrounding sentence; when unsure, **ask the user** before spawning.

1. **Known flag, used as a control directive** ("with write access", "skip the X MCP", or the token sits cleanly at the start before unrelated prompt text). Consume as a flag.
2. **Known flag, used as the subject of discussion** ("explain the `--write` flag and when to use it", "compare `--pure` vs `--no-pure`"). Naive parsing would silently flip the spawn's sandbox / scheduling. Keep the token in the prompt body instead — sentence context (verbs like "explain", "document", "describe", "compare", "what does X do", "when should I use X") is the signal.
3. **Unknown flag** (`--writte`, `--continous`). Could be a typo of a known flag or a literal subject of the prompt. cc-oc rejects unknown flags as stray argv tokens; **ask** with one line ("Did you mean `--write`? Or is `--writte` part of the prompt?") — never silently treat it as either.

This contextual reading is the single recovery for the separator-less form; cc-oc itself will not catch ambiguous flag-shaped tokens for you.

## Invocation tips

- Flag order in argv doesn't matter (flags are not positional).
- The heredoc terminator is single-quoted (`<<'OC_PROMPT'`) so `$VAR`, backticks, and embedded quotes in the prompt body pass through verbatim with no shell interpretation.
- If the prompt body itself contains a line that's literally `OC_PROMPT`, pick a different sentinel (e.g. `OC_PROMPT_BODY_END`).

## Output rules

Spawn always emits a started-session block and exits — cc-oc does **not** block on opencode's runtime. The block contains the pid, the pending session id, the log path, and the four follow-up commands (`/oc:tail`, `/oc:tail --follow`, `/oc:cancel`, `/oc:sessions`). Relay it verbatim — do not summarize.

After relaying, decide based on what the user asked for:

- **User wants the result** → run `/oc:tail <session-id> --follow`. It blocks on the log's terminal event (`step_finish` / `session_idle`) and exits, surfacing the final assistant text. Up to a 15-minute cap.
- **User kicked off and moved on** → end your turn. The log persists. They can pull it any time with `/oc:tail <session-id>` (or follow it later).
- **User wants to peek without waiting** → run `/oc:tail <session-id>` (no `--follow`). Returns immediately with the current digest.

Do not paraphrase or summarize opencode's response. Relay the final assistant text verbatim. If `/oc:tail --follow` reports the session ended in failure (the digest will show a `session_error` / `error` event), surface the error and stop. Do not retry silently. If the error names an unknown model, provider, or agent, see Recovery below.

## Recovery on model / provider / agent errors

cc-oc does not preflight `--provider`/`--model`/`--agent`; opencode does, and opencode's errors are clear. When the error is about an unknown one, you have two diagnostics — one for the model registry, one for agents:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" models --match "<hint>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" models --provider "<name>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" models --provider "<name>" --match "<hint>"

node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" agents --match "<hint>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" agents
```

**Quote multi-word hints.** `--match` and `--provider` each take a single string value. Without quotes, `--match deep seek` would parse `--match deep` and treat `seek` as a stray token (which cc-oc rejects). Always pass `--match "<hint>"` and `--provider "<name>"` even when the hint is a single word — it costs nothing and avoids the footgun.

`models` lists candidate `provider/model` pairs from opencode's own registry (the local cache plus any user-defined custom providers in `~/.config/opencode/opencode.json`). `agents` shells out to `opencode agent list` and returns just the names + kinds — opencode owns agent resolution (built-ins + global config + project config + plugin packages), cc-oc just exposes the resolved view in a form Claude can scan cheaply.

When and how:

- opencode says "unknown provider": run `models --provider "<what the user said>"` (the error block already prints up to 5 closest matches), or `models --match "<user's term>"` to search by model name across providers.
- opencode says "unknown model" with a correct provider: run `models --provider "<name>" --match "<user's term>"` to rank that provider's models against the hint.
- The user named only a model and the default provider rejected it: run `models --match "<model>"` to find which providers have it.
- opencode says "unknown agent": run `agents --match "<what the user said>"` to suggest the right id; or `agents` (no flags) to show the full list when the hint is too vague to rank.

Show the top 1–3 candidates to the user and ask before respawning. Do not auto-retry. If `models` itself reports "no model registry found", tell the user — they need to run `opencode` once to populate the cache. If `agents` itself fails (e.g. opencode binary missing), the same fix applies.

For no-whitespace (canonical-id) inputs, both diagnostics are *only* post-failure tools — never call them preflight on those. The pre-spawn lookup case is the whitespace rule under "Parsing user prompts into flags" above; the two paths don't overlap.
