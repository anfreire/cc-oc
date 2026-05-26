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
/oc:spawn --provider opencode-go --model deepseek-v4-flash -- "Review the staged diff"
/oc:spawn --continue <session-id> -- "Now add error handling to that function"
```

## Parsing user prompts into flags

When the user phrases a request naturally, translate it into flags before passing through. The prompt body (after `--`) should describe the task; everything that's a knob goes in flags.

| User phrasing | Flags |
|---|---|
| "use X from Y" / "with X from Y" / "via Y's X" / "Y's X model" | `--provider Y --model X` |
| "use Y/X" (already provider/model form) | split on `/`: `--provider Y --model X` |
| "use model X" (no provider) | omit both flags; let opencode use the default |
| "in the background" / "non-blocking" / "fire and forget" | `--bg` |
| "let it edit" / "allow writes" / "give it write access" | `--write` |
| "without the X MCP" / "skip the X plugin" | `--exclude-mcp X` |
| "include the X MCP" (when globally excluded) | `--include-mcp X` |
| "continue session <id>" / "follow up on <id>" / "resume <id>" | `--continue <id>` |
| "with reasoning" / "show its thinking" | `--reasoning` (foreground only) |
| "with high reasoning" / "<tier> variant" | `--variant <name>` |
| "in directory X" / "from path X" | `--cwd X` |
| "pin the X agent" | `--agent X` |

**Whitespace in the user's value decides whether to look it up first.** Apply this rule per field (provider and model independently):

- **No whitespace in the user's value** (e.g. `deepseek-v4-flash`, `gpt-5.5`, `opencode-go`, `claude-sonnet-4-6`): treat it as a canonical id. Pass through verbatim — do not lowercase, do not transform punctuation, do not guess. cc-oc does not pre-validate; opencode does. If opencode rejects it later, recover with `models` (see below).
- **Whitespace in the user's value** (e.g. "deepseek v4 flash", "OpenCode Go", "the DeepSeek flash model"): it's a hint, not an id. **Look it up before spawning**, using whichever shape fits:
  - provider only spaced → `oc.mjs models --match "<provider hint>"`
  - model only spaced (provider given as a clean id) → `oc.mjs models --provider <id> --match "<model hint>"`
  - both spaced → `oc.mjs models --match "<combined hint>"`

  Show the top 1–3 candidates to the user, confirm which they meant, then spawn with the exact ids returned. Never guess the transformation yourself — token boundaries, capitalization, dots vs hyphens vary per provider, so a guess can collide with the real id.

`--provider` and `--model` are paired — pass both or neither. `--continue <session-id>` resumes a prior opencode session with its full conversation history; find ids via `/oc:sessions`. For the full flag list, run `/oc:spawn --help`.

## Invocation

Two distinct shapes — pick by *who is composing the bash command*. They are not interchangeable.

### A. From the `/oc:spawn` slash command — use `--stdin`

This block runs when the user types `/oc:spawn …`. Claude Code substitutes `$ARGUMENTS` textually into the single-quoted heredoc body before bash sees it; `oc.mjs --stdin` then splits flags from the prompt body on the first ` -- ` separator. This is the *only* place `--stdin` belongs, and the *only* shape that requires the user to type ` -- ` before the prompt (`/oc:spawn --bg -- "your prompt"`).

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" spawn --stdin <<'__OC_ARGV__'
$ARGUMENTS
__OC_ARGV__
```

If the user forgot the ` -- ` separator, `oc.mjs` dies with `missing ` -- ` separator before prompt …`. Surface that error and ask the user to retry with ` -- ` before the prompt — do not silently retry by composing the call yourself.

### B. When you (Claude) compose the call yourself — use `--prompt-stdin`

If you are deciding autonomously to spawn opencode — *not* relaying a user-typed `/oc:spawn …` — use `--prompt-stdin`. Flags go in argv as normal; the prompt body goes alone in the heredoc. **There is no ` -- ` separator in this shape.** This is the same pattern the `oc-delegate` subagent uses.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" spawn [flags] --prompt-stdin <<'OC_PROMPT'
<the prompt body, may contain $, `, ", ', newlines — passes through verbatim>
OC_PROMPT
```

Examples:

```bash
# foreground, default provider/model
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" spawn --prompt-stdin <<'OC_PROMPT'
Review the staged diff for security issues.
OC_PROMPT

# background, custom provider + model
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" spawn --bg --provider google --model gemini-2.5-pro --prompt-stdin <<'OC_PROMPT'
Trace how config flows from CLI flag to runtime, then report.
OC_PROMPT
```

Do **not** use `--stdin` in this shape. `--stdin` exists to receive `$ARGUMENTS` as one opaque blob from the slash-command wrapper; composing a `--stdin` heredoc body yourself (flags and prompt fused on the same line) is the bug v0.1.5 added a fail-fast for, and `oc.mjs` will `die()` rather than mis-parse your flag-like tokens. `--prompt-stdin` keeps flags in argv and the prompt verbatim on stdin, so there is nothing to mis-parse.

## Output rules

- Foreground: stream the digest lines as they arrive; show the final assistant text last.
- Background: print the started-job message + the `/oc:tail` hint and stop. Do not block.
- Do not paraphrase or summarize opencode's response. Relay verbatim.
- If opencode errors out, surface stderr and stop. Do not retry silently. If the error names an unknown model or provider, see Recovery below.

## Recovery on model/provider errors

cc-oc does not preflight `--provider`/`--model`; opencode does, and opencode's errors are clear. When the error is about an unknown model or provider, you have one diagnostic tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" models --match <hint>
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" models --provider <name>
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" models --provider <name> --match <hint>
```

This lists candidate `provider/model` pairs from opencode's own registry (the local cache plus any user-defined custom providers in `~/.config/opencode/opencode.json`). When and how:

- opencode says "unknown provider": run `models --provider <what the user said>` (the error block already prints up to 5 closest matches), or `models --match <user's term>` to search by model name across providers.
- opencode says "unknown model" with a correct provider: run `models --provider <name> --match <user's term>` to rank that provider's models against the hint.
- The user named only a model and the default provider rejected it: run `models --match <model>` to find which providers have it.

Show the top 1–3 candidates to the user and ask before respawning. Do not auto-retry. If `models` itself reports "no model registry found", tell the user — they need to run `opencode` once to populate the cache.

For no-whitespace (canonical-id) inputs, `models` is *only* a post-failure tool — never call it preflight on those. The pre-spawn lookup case is the whitespace rule under "Parsing user prompts into flags" above; the two paths don't overlap.
