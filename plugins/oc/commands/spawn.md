---
description: Spawn an opencode task. Read-only and foreground by default. Add --bg to detach, --write to allow file writes.
argument-hint: "[flags] -- <prompt>"
allowed-tools: Bash(node:*)
---

`$ARGUMENTS` may include any of the following flags before the prompt:

| Flag | Effect |
|---|---|
| `--read-only` / `--write` | Sandbox mode. Default `--read-only` (no `--dangerously-skip-permissions`; opencode's own permission model applies). `--write` bypasses opencode's permission prompts. |
| `--bg` | Detach and return immediately. Default is foreground (blocking). |
| `--model <id>` | Model in `provider/model` form. Default: user config. Passed through verbatim — opencode validates. |
| `--variant <name>` | Model variant (e.g. reasoning effort on `opencode-go/deepseek-v4-flash`). Passed through verbatim; opencode silently ignores variants on providers that don't support them. |
| `--agent <name>` | Pin a specific opencode agent for this spawn. |
| `--cwd <path>` | Workspace root. Default: current directory. |
| `--continue <sid>` | Resume a previous opencode session. |
| `--fresh` | Explicitly request a new thread. Rejects `--continue`; otherwise no effect (the default is already a fresh thread). |
| `--exclude-mcp <names>` | Comma-separated MCP server names (from your opencode config) to disable for this spawn. Adds to the configured `excludeMcps` list. |
| `--include-mcp <names>` | Comma-separated MCP server names to re-enable for this spawn by removing them from the effective `excludeMcps` list. Lets you override a globally-configured exclusion for one run. |
| `--pure` / `--no-pure` | Disable / re-enable opencode's external plugins for this spawn. |
| `--project` / `--no-project` | Include / skip the project-level `.opencode/` config. |
| `--reasoning` | Include thinking/reasoning lines in the streamed digest. Foreground only — for `--bg` runs, pass `--reasoning` to `/oc:tail` instead. |
| `--json` | Emit machine-readable result. |

Pass the prompt after `--`. Examples:

```
/oc:spawn --read-only -- "Review the staged diff for security issues"
/oc:spawn --bg --read-only -- "Trace how config flows from CLI flag to runtime"
/oc:spawn --write -- "Apply the smallest fix that makes test foo pass"
/oc:spawn --exclude-mcp playwright -- "Quick scan, no browser MCP needed"
```

Run:

```bash
printf '%s' "$ARGUMENTS" | node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" spawn --stdin
```

(The pipe keeps shell metacharacters in your prompt from being interpreted by Bash — the raw string reaches `oc.mjs` as plain data.)

Output rules:
- For foreground: stream the digest lines as they arrive; show the final assistant text last.
- For background: print the started-job message + the `/oc:tail` hint and stop. Do not block.
- Do not paraphrase or summarize opencode's response. Relay verbatim.
- If opencode errors out, surface the stderr and stop. Do not retry silently.
