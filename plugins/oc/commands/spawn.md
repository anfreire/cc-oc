---
description: Spawn an opencode task. Read-only and foreground by default. Add --bg to detach, --write to allow file writes.
argument-hint: "[flags] <prompt>"
allowed-tools: Bash(node:*)
---

The user typed: `$ARGUMENTS`

This is the verbatim invocation argument string. Parse it into **flag tokens** and a **prompt body** using the flag table below, then invoke `oc.mjs spawn` with the flags in argv and the prompt body piped on stdin via a single-quoted heredoc.

`oc.mjs spawn` has one transport convention: **argv carries flags only; the prompt body comes in on stdin.** There is no `--` separator and no `--stdin` / `--prompt-stdin` flag. Mixing prompt words into argv will error.

Examples of how the user-typed form maps to the invocation:

```
/oc:spawn review the staged diff for security issues
  → node oc.mjs spawn <<'OC_PROMPT'
    review the staged diff for security issues
    OC_PROMPT

/oc:spawn --bg trace how config flows from CLI flag to runtime
  → node oc.mjs spawn --bg <<'OC_PROMPT'
    trace how config flows from CLI flag to runtime
    OC_PROMPT

/oc:spawn --write apply the smallest fix that makes test foo pass
  → node oc.mjs spawn --write <<'OC_PROMPT'
    apply the smallest fix that makes test foo pass
    OC_PROMPT

/oc:spawn --provider opencode-go --model deepseek-v4-flash review the staged diff
  → node oc.mjs spawn --provider opencode-go --model deepseek-v4-flash <<'OC_PROMPT'
    review the staged diff
    OC_PROMPT

/oc:spawn --continue ses_abc now add error handling to that function
  → node oc.mjs spawn --continue ses_abc <<'OC_PROMPT'
    now add error handling to that function
    OC_PROMPT
```

## Parsing user prompts into flags

When the user phrases a request naturally, translate it into flags before composing the call. The prompt body should describe the task; everything that's a knob goes in flags.

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

## How to parse `$ARGUMENTS`

Walk the typed string left-to-right. While the next token is a known flag (from the table above and `oc.mjs spawn --help`), consume it (and its value, if the flag takes one). As soon as you hit a token that isn't a known flag, **everything from that point on is the prompt body** — keep it verbatim, preserving spaces, punctuation, and casing.

The prompt body may contain `--`, `--something`, quotes, `$`, backticks — none of it gets reinterpreted, because it lands inside a single-quoted heredoc.

If a `$ARGUMENTS` token looks like a flag (`--foo`) but isn't in the known flag set, treat it as the start of the prompt body (don't pass it as a flag to `oc.mjs` — that would throw `unknown flag`).

### When a known-flag token is part of the prompt

Some natural-language prompts begin with — or are entirely *about* — a token that happens to match a known flag (e.g. *"explain the `--write` flag and when to use it"*, *"document `--bg` for new contributors"*, *"compare `--pure` vs `--no-pure`"*). Naive left-to-right parsing would consume `--write` / `--bg` / `--pure` as control flags and silently mutate the spawn's behavior (enabling writes, backgrounding, dropping plugins) instead of preserving the user's prompt text.

Use sentence context to disambiguate:

- If the surrounding words frame the flag-token as a *subject of discussion* — verbs like "explain", "document", "describe", "compare", "what does X do", "when should I use X" — keep the token in the prompt body. Do not pass it as a control flag.
- If the surrounding words frame it as a *control directive* — "in the background", "with write access", "skip the X MCP", or the token sits cleanly at the start before unrelated prompt text — pass it as a flag.
- When the user's intent is ambiguous, **ask before spawning**. A one-line clarification ("Did you want `--write` as a flag, or is the prompt about the `--write` flag itself?") is cheaper than running with the wrong sandbox or backgrounding policy.

This is a known design tradeoff of the v0.2.0 separator-less form. The single recovery is your contextual reading; cc-oc itself will not catch this for you.

## Invocation template

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" spawn <parsed flag tokens> <<'OC_PROMPT'
<parsed prompt body, verbatim>
OC_PROMPT
```

- The flag tokens go in argv in the order you parsed them (or any order — flags are not positional).
- The heredoc terminator is single-quoted (`<<'OC_PROMPT'`), which is what makes `$VAR`, backticks, and embedded quotes pass through unchanged.
- If the prompt body itself contains a line that's literally `OC_PROMPT`, pick a different sentinel (e.g. `OC_PROMPT_BODY_END`).

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
