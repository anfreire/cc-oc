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

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" spawn --stdin <<'__OC_ARGV__'
$ARGUMENTS
__OC_ARGV__
```

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
