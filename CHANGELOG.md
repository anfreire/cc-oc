# Changelog

## 0.1.0 — 2026-05-15

Initial release.

A controlled launcher for [opencode](https://opencode.ai) from inside Claude Code.

Commands:
- `/oc:spawn` — spawn an opencode task (foreground; `--bg` for background)
- `/oc:tail` — stream or peek a session's events (with `--follow` and opencode session-DB fallback)
- `/oc:sessions` — list + inspect spawned sessions
- `/oc:cancel` — cancel one session or `--all` running

Other surface:
- `oc-delegate` subagent — context-firewall forwarder for autonomous use
- Optional `~/.claude/oc.json` configures defaults for every spawn (model, variant, agent, sandbox, MCP exclusions, log retention)
- Per-spawn `--exclude-mcp` to disable specific MCP servers from your opencode config for one run
- Per-spawn `--include-mcp` to re-enable globally-excluded servers for a single run (escape hatch)
- Log retention runs automatically on CC SessionEnd; running bg jobs at session end are marked `detached` (the child keeps running)

Design notes:
- The plugin never modifies your opencode config files. When a spawn excludes MCP servers, cc-oc writes a tiny per-spawn override file and points `OPENCODE_CONFIG_DIR` at it so opencode's native deep-merge disables those servers for that run only.
- Model and variant strings are passed through to opencode verbatim. opencode validates them itself — wrong ids surface as a clean error event.
- No `setup` or `reset` slash commands. Setup checks are folded into spawn-time errors. Maintenance lives in the SessionEnd `gc` hook plus, as an escape hatch, `rm -rf ~/.claude/plugins/data/oc/`.
