# cc-oc

> Thin launcher for [opencode](https://opencode.ai) from inside [Claude Code](https://claude.ai/code).

Five slash commands — `/oc:spawn`, `/oc:wait`, `/oc:debug`, `/oc:sessions`, `/oc:cancel` — that wrap `opencode run`. Always detached, fire-and-forget. No config, no MCP brokerage, no abstractions on top of opencode: every flag passes straight through, every behavior comes from opencode itself. Sessions are scoped to the current Claude Code session.

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

cc-oc does **not** validate flag values — opencode does. After spawn, cc-oc waits up to 60 seconds for opencode to emit its first event so the real session id can be captured and startup-time rejections (bad model, bad auth, config errors) surface in the spawn output. Once opencode emits its first event, cc-oc prints the session id and detaches; opencode keeps running.

On a failed start the output also prints a `recovery:` line — the absolute path to a bundled guide (`reference/recovery.md`) covering how to find a valid model/agent, decode the provider error, and handle a session stuck `running` on a usage limit.

### `/oc:wait`

Block until a session finishes, then **return the result**: the agent's final answer on stdout (exit `0`), or `session <id> error: <message>` on stderr (exit `1`) on failure. This is the canonical way to get an answer — run it under Monitor with `persistent: true` (and `2>&1`, so failures notify too) and the completion notification carries the answer, no separate read step.

```text
/oc:wait ses_abc
```

### `/oc:debug`

Inspect a session — progress, tool calls, failures. Prints a status header (`session:` / `status:` / `activity:`) followed by the **full event trace** (model text, tool calls, errors, stderr), parsed and rendered from the session log. No flags, one output shape for every session state: a running session shows its trace so far, a missing or empty log renders `(no events)`. To get the agent's final answer, use `/oc:wait`.

```text
/oc:debug ses_abc                 # full id or unique prefix
```

### `/oc:sessions`

List sessions spawned in the current Claude Code session.

```text
session         started   status   prompt
ses_abc12345    2m ago    running  review the staged diff
ses_def67890    5m ago    done     fix the failing test
```

Four statuses:
- `running` — the opencode child is alive.
- `done` — the child exited and the log doesn't end in an error.
- `error` — the child exited with an unrecovered error as the log's last word, or died before producing any events. An error opencode recovered from (e.g. by retrying on a fallback model) doesn't fail the session — it stays visible in `/oc:debug`, but the verdict comes from what happened after it.
- `cancelled` — `/oc:cancel` was called.

### `/oc:cancel`

Abort a running session by id. Best-effort: the ledger entry is marked `cancelled` first, then `opencode session abort`, then `SIGTERM` the process group. No-op on already-finished sessions.

```text
/oc:cancel ses_abc
```

## How it works

```
/oc:spawn "<prompt>"
  └─ spawn `opencode run --format json` detached: opencode owns its own process group,
     stdio wired to a temp log file via raw fds
  └─ probe up to 60s for a session id:
       sessionID, no pending error → rename temp log to <sid>.ndjson, ledger entry as `running`, exit 0
       exit w/ unrecovered error   → surface error inline, exit 1
       exit w/ no events           → child died silently; exit 1
       timeout                     → kill child, surface the pending error if any, exit 1
     (an error event alone never settles the probe — with model fallbacks opencode
      retries and recovers; opencode exiting is what makes an error final)
  └─ print session id + the follow-up commands, child.unref(), exit
     (opencode keeps running until done; cc-oc has long left)

/oc:wait / /oc:debug / /oc:sessions
  └─ reconcile-on-read: pid dead → error only if the log ends in an unrecovered error, lazily

/oc:cancel <id>
  └─ if running: mark cancelled, opencode session abort + SIGTERM process group
  └─ else:       no-op

SessionEnd hook
  └─ prune logs older than 14 days, or oldest-first when over 500 MB total
```

The 60-second probe is **observation-only**: cc-oc never preflights model registries, validates API keys, or shadows opencode's startup logic. It watches opencode's own log + child-exit signal for a window that's generous enough to capture opencode's real session id and surface any startup-time error verbatim.

## Files written by this plugin

| Path | What |
|---|---|
| `~/.claude/plugins/data/oc/logs/<sid>.ndjson` | Per-session opencode event logs (`0600`). |
| `~/.claude/plugins/data/oc/sessions.json` | Session index (`0600`). |

Data dir is `0700`. Logs auto-pruned on SessionEnd (14 days / 500 MB total).

Set `CLAUDE_HOME=/some/path` to relocate.

## License

MIT. See [`LICENSE`](LICENSE).

---

**More agent tooling** — [patch-cc](https://github.com/anfreire/patch-cc): patch the Claude Code binary (live thinking, Codex models) · [summon-cc](https://github.com/anfreire/summon-cc): give your agent a crew of Claude Code workers · [omoctl](https://github.com/anfreire/omoctl): manage oh-my-openagent profiles · [wiki-spaces](https://github.com/anfreire/wiki-spaces): a wiki your AI agent keeps
