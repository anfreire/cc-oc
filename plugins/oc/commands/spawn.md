---
description: Start an opencode session detached. Fire-and-forget; cc-oc returns once opencode has produced its first event or surfaces an error.
argument-hint: "[flags] << <prompt>"
allowed-tools: Bash(node:*)
---

The user typed: `$ARGUMENTS`

Split that into flag tokens + a prompt body, then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc.mjs" spawn [flags] <<'EOF'
<prompt>
EOF
```

Single-quote the heredoc terminator (`<<'EOF'`) to pass the prompt verbatim; drop the quotes only if you want cc-oc to expand environment variables in the prompt.

## Flags (all optional, all pass through to `opencode run`)

| Flag | Meaning |
|---|---|
| `--dir <path>` | Workspace root (default: current directory) |
| `--model <id>` | Opencode model id in `provider/model` form (e.g. `anthropic/claude-sonnet-4-6`) |
| `--agent <name>` | Pin a specific opencode agent |
| `--variant <tier>` | Reasoning-effort variant (provider-specific: `high`, `max`, `minimal`, …) |
| `--thinking` | Show reasoning blocks in the event stream |
| `--dangerously-skip-permissions` | Bypass opencode's permission prompts for this spawn |
| `--session <session-id>` | Resume that specific opencode session |

cc-oc does not validate flag values — opencode does. If a model / agent / variant id is wrong, opencode will reject it during the 20s startup probe and cc-oc surfaces the error inline.

## Output

Two shapes:

1. **Started.** The session is past startup; opencode keeps running detached.
   ```
   Started OpenCode session.
   session: <id>
   log:     <path>

   Next:
     /oc:tail <id>           peek (last 10 events)
     /oc:tail <id> --follow  wait for completion
     /oc:cancel <id>         abort
     /oc:sessions            list sessions
   ```

2. **Failed to start.** Opencode errored during the probe phase (e.g. invalid model, agent, or variant; permissions blocked; network error connecting to the provider). The error message from opencode is surfaced inline.
   ```
   OpenCode failed to start.
   error: <error-message>
   log:   <path>
   ```
