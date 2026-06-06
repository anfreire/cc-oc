# cc-oc

> Thin launcher for [opencode](https://opencode.ai) from inside [Claude Code](https://claude.ai/code).

Five slash commands — `/oc:spawn`, `/oc:tail`, `/oc:wait`, `/oc:sessions`, `/oc:cancel` — that wrap `opencode run`. Always detached, fire-and-forget. No config, no MCP brokerage, no abstractions on top of opencode: every flag passes straight through, every behavior comes from opencode itself. Sessions are scoped to the current Claude Code session.

No daemon, no broker, no npm dependencies. Native Node ESM.

## Install

```text
/plugin marketplace add anfreire/cc-oc
/plugin install oc@cc-oc
/reload-plugins
```

**Prerequisites:**

- A working [opencode](https://opencode.ai) (`curl -fsSL https://opencode.ai/install | bash`, then `opencode auth login`).
- Node.js `>= 18`.

Configure opencode itself (models, MCPs, permissions, agents) via `~/.config/opencode/opencode.json` or your workspace's `.opencode/`. cc-oc does not touch those files and has no config of its own.

## Commands

### `/oc:spawn`

Start an opencode session detached. Prompt body is piped on stdin via a single-quoted heredoc (so `$`, backticks, and quotes inside the body pass through verbatim).

```text
/oc:spawn review the staged diff
/oc:spawn --model anthropic/claude-sonnet-4-6 fix the failing test
/oc:spawn --thinking --variant high trace the bug from request to response
/oc:spawn --dangerously-skip-permissions apply the smallest patch that makes it pass
/oc:spawn --session ses_abc continue from where we left off
```

Flags (all optional, all pass through to `opencode run`):

| Flag | Meaning |
|---|---|
| `--dir <path>` | Workspace root (default: current directory) |
| `--model <id>` | Opencode model id in `provider/model` form |
| `--agent <name>` | Pin a specific opencode agent |
| `--variant <tier>` | Reasoning-effort variant (provider-specific) |
| `--thinking` | Show reasoning blocks in the event stream |
| `--pure` | Run opencode without external plugins |
| `--dangerously-skip-permissions` | Bypass opencode's permission prompts for this spawn |
| `--session <sid>` | Resume that specific opencode session |

cc-oc does **not** validate flag values — opencode does. After spawn, cc-oc waits up to 20 seconds for opencode to emit its first event so the real session id can be captured and startup-time rejections (bad model, bad auth, config errors) surface in the spawn output. Once opencode emits its first event, cc-oc prints the session id and detaches; opencode keeps running.

On a failed start the output also prints a `recovery:` line — the absolute path to a bundled guide (`reference/recovery.md`) covering how to find a valid model/agent, decode the provider error, and handle a session stuck `running` on a usage limit.

### `/oc:tail`

Peek at or stream a session's events.

```text
/oc:tail ses_abc                  # specific session (full id or unique prefix)
/oc:tail ses_abc --follow         # block until terminal
/oc:tail ses_abc --events 50      # last 50 events
/oc:tail ses_abc --events 5 --follow   # last 5 then stream new
```

`--follow` blocks up to 15 minutes. `--events N` defaults to 1. Combinable.

### `/oc:wait`

Block until a session finishes, then print a one-line summary — session id, the session's title (or prompt), and an `/oc:tail` pointer. Exits `0` on done, `1` on error. Run it in the background to be notified on completion without blocking.

```text
/oc:wait ses_abc
```

### `/oc:sessions`

List sessions spawned in the current Claude Code session.

```text
session         started   status   prompt
ses_abc12345    2m ago    running  review the staged diff
ses_def67890    5m ago    done     fix the failing test
```

Three statuses:
- `running` — opencode child is alive and the log has no terminal event.
- `done` — the log shows `session_idle` / `step_finish`, or `/oc:cancel` was called.
- `error` — the log shows a `session_error` / `error` event, or the child died silently.

### `/oc:cancel`

Abort a running session by id. Best-effort: `opencode session abort` first, then `SIGTERM` the process group, then the ledger entry is marked `done`. No-op on already-finished sessions.

```text
/oc:cancel ses_abc
```

## How it works

```
/oc:spawn "<prompt>"
  └─ spawn `opencode run --format json` detached: opencode owns its own process group,
     stdio wired to a temp log file via raw fds
  └─ probe up to 20s for the first event:
       error event  → surface error, kill child, exit 1
       sessionID    → rename temp log to <sid>.ndjson, ledger entry as `running`, exit 0
       timeout      → kill child, exit 1
       no events    → child died silently; exit 1
  └─ print session id + the four follow-up commands, child.unref(), exit
     (opencode keeps running until done; cc-oc has long left)

/oc:tail / /oc:sessions
  └─ reconcile-on-read: scan the log for terminal events, update ledger status lazily

/oc:cancel <id>
  └─ if running: opencode session abort + SIGTERM process group, mark done
  └─ else:       no-op

SessionEnd hook
  └─ prune logs older than 14 days, or oldest-first when over 500 MB total
```

The 20-second probe is **observation-only**: cc-oc never preflights model registries, validates API keys, or shadows opencode's startup logic. It watches opencode's own log + child-exit signal for a window that's generous enough to capture opencode's real session id and surface any startup-time error verbatim.

## Files written by this plugin

| Path | What |
|---|---|
| `~/.claude/plugins/data/oc/logs/<sid>.ndjson` | Per-session opencode event logs (`0600`). |
| `~/.claude/plugins/data/oc/sessions.json` | Session index (`0600`). |

Data dir is `0700`. Logs auto-pruned on SessionEnd (14 days / 500 MB total).

Set `CLAUDE_HOME=/some/path` to relocate.

## License

MIT. See [`LICENSE`](LICENSE).
