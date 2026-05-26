# cc-oc

> Controlled launcher for [opencode](https://opencode.ai), invoked from inside [Claude Code](https://claude.ai/code). Per-spawn MCP control, session ledger, foreground or detached.

Each `/oc:spawn` is one ephemeral `opencode run --format json` invocation against **your own opencode config** (`~/.config/opencode/opencode.json` + workspace `.opencode/`). The plugin only writes a tiny per-spawn override file when you ask it to disable specific MCP servers — otherwise opencode runs entirely against your existing setup, untouched.

A thin local ledger tracks the sessions spawned by `/oc:spawn` so `/oc:tail`, `/oc:sessions`, and `/oc:cancel` can filter to *your* bridge sessions rather than every opencode session on the machine.

No broker, no daemon, no extra processes. Zero npm dependencies. Native Node ESM.

## Install

`cc-oc` is published as a **standalone Claude Code marketplace** — you add the repo as a marketplace, then install the `oc` plugin from it.

```text
/plugin marketplace add anfreire/cc-oc
/plugin install oc@cc-oc
/reload-plugins
```

After `/reload-plugins` (or on the next Claude Code session), `/oc:spawn`, `/oc:tail`, `/oc:sessions`, and `/oc:cancel` become available.

**Uninstall:**

```text
/plugin uninstall oc@cc-oc
/plugin marketplace remove cc-oc
```

**Prerequisites:**

- A working [opencode](https://opencode.ai):
  ```bash
  curl -fsSL https://opencode.ai/install | bash
  opencode auth login
  ```
- Node.js `>= 18`.

"Zero config" means *zero cc-oc config* — the plugin works out of the box with no `~/.claude/oc.json`. It does not configure opencode for you; whatever you'd see typing `opencode run "…"` directly is what cc-oc launches. If opencode itself is unauthenticated, has no model selected, or otherwise can't run, the first `/oc:spawn` will surface opencode's own error verbatim.

## Quick start

```text
/oc:spawn summarize the architecture of this repo
/oc:spawn --bg find every place that calls foo() and report
/oc:spawn --exclude-mcp playwright quick scan, no browser needed
/oc:spawn --provider opencode-go --model deepseek-v4-flash review the diff
/oc:spawn --continue <id> now write tests for what you found
/oc:tail                                 # peek at the latest job
/oc:tail --follow                        # block until done
/oc:sessions                             # list your spawned jobs
/oc:cancel <id>                          # abort one
/oc:cancel --all                         # abort all running in this CC session
```

Append `--help` to any command for the full flag list inline.

## Commands

| Command | Purpose |
|---|---|
| `/oc:spawn` | Spawn an opencode task. Foreground by default; opencode's own permission gating applies (override with `--write`). Flags: `--bg`, `--write`, `--provider` + `--model` (paired), `--variant`, `--agent`, `--cwd`, `--continue <sid>`, `--exclude-mcp <names>`, `--include-mcp <names>`, `--pure` / `--no-pure`, `--project` / `--no-project`, `--reasoning`, `--json`. Prompt follows the flags directly — no separator. |
| `/oc:tail` | Stream/peek a session's events. Flags: `--follow`, `--lines N`, `--since ms`, `--reasoning`, `--raw`, `--json`. No arg → latest active job. |
| `/oc:sessions` | List + inspect. Flags: `--all`, `--json`. Pass a session id (or unique prefix) for full details. |
| `/oc:cancel` | Cancel one or all. `--all` scopes to this CC session; add `--workspace` to widen. `--json` for machine-readable. |

### `oc-delegate` subagent

The plugin also ships an optional `oc-delegate` subagent. Claude may invoke it on its own when an autonomous plan reaches a step that would bloat the parent context (large explorations, second-opinion reviews, sandboxed writes). The subagent makes one delegated `/oc:spawn` call and returns only a short summary — the verbatim opencode transcript stays in the subagent's own context.

## Resuming a session

opencode sessions are multi-turn. `--continue <session-id>` makes a `/oc:spawn`
a **follow-up** to a prior session — the spawned model receives that session's
full conversation history, not a cold prompt.

```text
/oc:spawn trace how config loading flows from flag to runtime
/oc:sessions                                          # find the session id
/oc:spawn --continue ses_… now write tests for that path
```

Get ids from `/oc:sessions`. This maps to opencode's `--session` (resume *that
specific* session) — distinct from opencode's bare `--continue`, which resumes
whatever ran last.

## Configuration

Optional file at `~/.claude/oc.json`. Defaults are sensible — if you skip it entirely, the plugin works.

```jsonc
{
  "$schema": "https://github.com/anfreire/cc-oc/raw/main/plugins/oc/schemas/oc.config.schema.json",

  "opencode": {
    "model":                null,         // null = inherit opencode default
    "variant":              null,
    "agent":                null,
    "sandbox":              "read-only",  // "read-only" | "workspace-write"
    "excludeMcps":          [],           // MCP server names from your opencode config to disable on every spawn
    "disableProjectConfig": false,        // skip <cwd>/.opencode/
    "pure":                 false         // pass --pure to opencode (skip its external plugins)
  },

  "retention": { "logsDays": 14, "maxLogsMb": 500 }
}
```

The `$schema` URL gives you tooltips and validation in editors that understand JSON Schema (VS Code, Cursor, IntelliJ, …).

### Per-spawn overrides

Any `/oc:spawn` flag overrides the user config for that single call:

- `--provider <name>` + `--model <id>` (paired) / `--variant <name>` / `--agent <name>` — passed through verbatim; opencode validates.
- `--read-only` / `--write` — sandbox mode (see below).
- `--pure` / `--no-pure` — disable / re-enable opencode's external plugins.
- `--project` / `--no-project` — include / skip the workspace's `.opencode/` config.
- `--exclude-mcp <names>` / `--include-mcp <names>` — adjust the configured `excludeMcps` for one call.

### Sandbox semantics

`--read-only` (the default) means cc-oc does **not** pass `--dangerously-skip-permissions` to opencode. The spawn runs under opencode's own permission model (`permission.edit`, `permission.bash`, etc. in your opencode config). With opencode's stock defaults, write tools are gated and the non-interactive run treats them as denied, which is effectively read-only in practice — but if you've explicitly set `permission.edit: "allow"` in your opencode config, that setting wins.

`--write` passes `--dangerously-skip-permissions` to opencode, which bypasses every permission prompt for that spawn.

**There is no plugin-side enforcement of read-only beyond not skipping permissions. The plugin is a launcher, not a permission gate.**

### Models

Specify models as `--provider <name> --model <id>` (e.g. `--provider anthropic --model claude-sonnet-4-6`, `--provider opencode-go --model deepseek-v4-flash`). The two flags are paired — pass both or neither. cc-oc joins them server-side into the `provider/model` form opencode expects and passes the result through verbatim; **opencode owns model validity** and there is no plugin-side preflight or registry to keep in sync.

When you ask Claude in natural language ("use the DeepSeek flash model from OpenCode Go"), Claude is instructed to call a built-in `oc.mjs models` diagnostic to resolve the words into a real id and confirm with you before spawning — never to guess the transformation. When opencode rejects a typo'd canonical id, Claude uses the same diagnostic to suggest alternatives. The diagnostic reads opencode's own registry: `~/.cache/opencode/models.json` (populated by running `opencode` once) plus any custom providers you've defined in `~/.config/opencode/opencode.json`.

Optional `--variant <name>` is passed straight through to opencode (used by providers like `opencode-go/deepseek-v4-flash` to select reasoning effort). opencode silently ignores variants on providers that don't support them.

## Controlling which opencode MCP servers run

The bit you can't easily do by editing your opencode config: **per-spawn MCP control without touching the global file**.

- **Config default**: `opencode.excludeMcps: ["playwright"]` disables `playwright` on every `/oc:spawn`.
- **Per-call exclude**: `/oc:spawn --exclude-mcp github,notion <prompt>` adds names to the exclude list for one spawn.
- **Per-call include (escape hatch)**: `/oc:spawn --include-mcp playwright <prompt>` removes names from the effective exclude list for one spawn — use this to re-enable a server you've excluded globally. `--exclude-mcp` is applied first, so `--exclude-mcp foo --include-mcp foo` is a no-op rather than order-dependent.

Under the hood, when there's anything to exclude, the plugin writes a tiny `opencode.json` (with `mcp.<name>.enabled = false` for each listed server) to a per-spawn `OPENCODE_CONFIG_DIR`. opencode deep-merges this on top of your global + project configs, so listed servers are disabled and the rest are untouched. When there's nothing to override, the plugin sets no env var at all and opencode runs entirely against your unmodified config.

## How it works

```
/oc:spawn "<prompt>"
  └─ load ~/.claude/oc.json (defaults if missing)
  └─ apply per-call flag overrides
  └─ if anything to override (effective excludeMcps non-empty):
       write per-spawn opencode.json into ~/.claude/plugins/data/oc/runs/<id>/
       and pass it as OPENCODE_CONFIG_DIR
  └─ spawn `opencode run --format json` (foreground or detached)
  └─ stream NDJSON events → render digest line → write log
  └─ record the session in the local ledger so /oc:tail and friends can find it
```

## Trust model

The plugin runs entirely on your machine, against your `~/.claude/oc.json` and your authenticated `opencode`. The slash-command wrappers instruct Claude to pipe your prompt body through a single-quoted heredoc on stdin, so shell metacharacters in your prompt are not reinterpreted by the shell. The plugin never opens a network listener and never uploads anything.

## Background jobs at CC session end

When a Claude Code session ends, the `gc` hook marks any still-running `/oc:spawn --bg` jobs as `detached` in the ledger — **the opencode child keeps running**. The next time you start CC, `/oc:sessions --all` will surface those detached jobs; `/oc:tail <id>` still works against the log. To kill a detached job, find its pid in `/oc:sessions <id>` and SIGTERM it yourself, or use `/oc:cancel <id>` if the process is still tracked.

## Troubleshooting

- **`opencode binary not found`** — install opencode (`curl -fsSL https://opencode.ai/install | bash`) and rerun. If opencode lives somewhere non-standard, set `OPENCODE_BIN=/abs/path/to/opencode` in your shell rc so subprocess shells (including CC subagents) can find it.
- **`UnknownError: Model not found: ...`** — opencode rejected the model id. Pass `--provider <name> --model <id>` (paired) with an id opencode recognizes. Claude is instructed to run cc-oc's built-in `oc.mjs models --match <hint>` diagnostic to suggest alternatives when this fails; you can also list everything via `opencode models`.
- **MCP server didn't load** — check whether `excludeMcps` (or `--exclude-mcp`) names it. Otherwise it's an opencode-side issue — debug with `opencode mcp list`.
- **Background job appears "running" but is done** — call `/oc:tail` or `/oc:sessions` again. Each call reconciles by reading the log for terminal events.
- **Stale state / disk usage** — log retention runs automatically on every CC SessionEnd (controlled by `retention.logsDays` and `retention.maxLogsMb` in `oc.json`). To force a hard wipe, `rm -rf ~/.claude/plugins/data/oc/`.

## Files written by this plugin

| Path | What |
|---|---|
| `~/.claude/oc.json` | (Optional) your config. |
| `~/.claude/plugins/data/oc/runs/<id>/opencode.json` | Per-spawn override file. Only written when a spawn has something to override. |
| `~/.claude/plugins/data/oc/logs/*.ndjson` | Per-session opencode NDJSON event logs (`0600`). |
| `~/.claude/plugins/data/oc/sessions.json` | Session index ledger (`0600`). |

Data dir is `0700`. Logs auto-pruned on CC SessionEnd.

Set `CLAUDE_HOME=/some/path` to point all of the above at a non-default Claude Code root; the config file and the plugin data dir both honour it.

## License

MIT. See [`LICENSE`](LICENSE).
