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

| Flag                             | Meaning                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `--dir <path>`                   | Workspace root (default: current directory)                                     |
| `--model <id>`                   | Opencode model id in `provider/model` form (e.g. `anthropic/claude-sonnet-4-6`) |
| `--agent <name>`                 | Pin a specific opencode agent                                                   |
| `--variant <tier>`               | Reasoning-effort variant (provider-specific: `high`, `max`, `minimal`, …)       |
| `--thinking`                     | Show reasoning blocks in the event stream                                       |
| `--pure`                         | Run opencode without external plugins                                           |
| `--dangerously-skip-permissions` | Bypass opencode's permission prompts for this spawn                             |
| `--session <session-id>`         | Resume that specific opencode session                                           |

cc-oc does not validate flag values — opencode does. If a model / agent / variant id is wrong, opencode will reject it during the 20s startup probe and cc-oc surfaces the error inline.

## Output

Two shapes:

1. **Started.** The session is past startup; opencode keeps running detached.
   ```
   Started OpenCode session.
   session: <id>
   log:     <path>

   Get the answer (blocks; run_in_background to be pinged when ready):
     node <abs>/scripts/oc.mjs wait <id>

   Watch or inspect events:
     /oc:tail <id>           peek last events
     /oc:tail <id> --follow  stream live events
     /oc:cancel <id>         abort
     /oc:sessions            list sessions
   ```

2. **Failed to start.** Opencode errored during the probe phase (e.g. invalid model, agent, or variant; permissions blocked; network error connecting to the provider). The error message from opencode is surfaced inline.
   ```
   OpenCode failed to start.
   error:    <error-message>
   log:      <path>
   recovery: <path to reference/recovery.md>
   ```

    On any failure — or a session stuck `running` with no new events (usage limit) — read the `recovery:` file above (`reference/recovery.md`) for how to find models/agents, decode the error, and resume.

## Related commands

- `/oc:wait` — wait for a session to finish, then print its final answer
- `/oc:tail` — stream or peek a session's events
- `/oc:cancel` — cancel a running session
