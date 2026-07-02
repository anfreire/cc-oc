---
description: Start an opencode session detached. Fire-and-forget; cc-oc returns once opencode has produced its first event or surfaces an error.
argument-hint: "[flags] <prompt>"
allowed-tools: Bash(node:*)
---

The user typed: `$ARGUMENTS`

Split that into flag tokens + a prompt body, then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" spawn [flags] <<'EOF'
<prompt>
EOF
```

Keep the heredoc terminator single-quoted (`<<'EOF'`) so the prompt passes verbatim; unquote it when the shell should expand variables in the prompt.

Flags — all optional, passed through to `opencode run` verbatim; cc-oc validates nothing:

- `--dir <path>` — workspace root (default: current directory)
- `--model <id>` — model id in `provider/model` form
- `--agent <name>` — pin a specific opencode agent
- `--variant <tier>` — reasoning-effort variant (provider-specific: `low`, `medium`, `high`, `xhigh`, `max`, …)
- `--thinking` — include reasoning blocks in the event stream
- `--pure` — run opencode without external plugins
- `--dangerously-skip-permissions` — bypass opencode's permission prompts for this spawn
- `--session <session-id>` — resume that opencode session

On success it prints the session id, log path, and the follow-up commands (`wait` for the answer; `debug`, `cancel`, `sessions` to manage). Startup errors surface inline once opencode gives up on them — an error opencode recovers from (e.g. a model fallback) doesn't fail the spawn. On any failure, or a session stuck `running` with no new events, read the printed `recovery:` file (`reference/recovery.md`).
