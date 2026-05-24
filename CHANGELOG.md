# Changelog

## 0.1.5 — 2026-05-25

Fail-fast on missing `--` separator in `/oc:spawn`.

- **`/oc:spawn` now errors when the prompt would be silently mangled by flag parsing.** Previously, an invocation like `/oc:spawn review --no-pure now` (no `--` separator, `--no-pure` sitting in the would-be prompt) ran the whole stdin buffer through the flag parser, which consumed `--no-pure` as a boolean and stripped it from the prompt. The `--stdin` dispatcher now `die()`s with `missing ` -- ` separator before prompt …` when the buffer has flag-like tokens (`--xyz` / `-x`) but no `--` boundary. Spawn-only; `/oc:tail`, `/oc:sessions`, `/oc:cancel` take no prompt body and are unaffected. The bare-shorthand `/oc:spawn "just review the diff"` (no flag-like substrings) still works.

## 0.1.4 — 2026-05-24

Natural-language model/provider parsing without becoming a wrapper.

- **`--provider` + `--model` split.** `/oc:spawn` previously took the combined `provider/model` form via a single `--model`. The two are now separate flags and paired (pass both or neither); cc-oc joins them server-side into the `provider/model` string opencode expects. This makes Claude's natural-language → flag translation cleaner — "use X from Y" maps to `--provider Y --model X`.
- **New `oc.mjs models` diagnostic subcommand.** Lists providers and models from opencode's own registry: `~/.cache/opencode/models.json` ∪ `~/.config/opencode/opencode.json::provider.*.models` (user-defined custom providers are included). Four call shapes — bare (provider list with counts), `--provider X` (X's models), `--match Y` (token-ranked candidates across all providers), `--provider X --match Y` (ranked within X) — plus `--json`. Unknown providers under `--provider` print up to 5 closest matches scored against the typed name + the optional model hint. `models` is a subcommand only — there is no `/oc:models` slash command — and is invoked by Claude in exactly two situations: *before* a spawn when the user wrote the model or provider with whitespace ("DeepSeek V4 Flash" — natural-language hint, never guess the transformation), and *after* a spawn that opencode rejected on an unknown model/provider (typo recovery).
- **`spawn.md` rewritten** with a natural-language → flag table, the whitespace-decides rule for model/provider values, and an explicit recovery procedure. No-whitespace values are always passed through verbatim; cc-oc does not preflight.

## 0.1.3 — 2026-05-16

Session-scoping fix and resume documentation.

- **Per-Claude-Code-session scoping fix.** `/oc:sessions`, `/oc:tail` (with no session argument), `/oc:cancel --all`, and the SessionEnd `gc` hook are meant to scope to the current Claude Code session, but the session id was read from `CC_SESSION_ID` / `OC_PLUGIN_SESSION_ID` — environment variables Claude Code does not set — so it was always empty and those commands silently widened to every cc-oc session in the workspace. The id is now read from `CLAUDE_CODE_SESSION_ID` (the variable Claude Code actually exports), with the former names kept as fallbacks.
- Session resume is now documented. `/oc:spawn --continue <session-id>` resumes a prior opencode session with its full conversation history; the flag worked already but had no example or explanation outside `oc.mjs --help`. `spawn.md`, the `oc-delegate` subagent, and the README now cover it — including how cc-oc's `--continue <id>` maps to opencode's `--session` (resume a specific session), distinct from opencode's bare `--continue` (resume the last session).

## 0.1.2 — 2026-05-16

Security and correctness fixes.

- **Shell-safety fix — present since 0.1.0; updating is recommended.** The four `/oc:*` slash-command wrappers passed `$ARGUMENTS` to `oc.mjs` as `<<< "$ARGUMENTS"`. Claude Code substitutes `$ARGUMENTS` textually, so a user's own quotes collided with the wrapper's: any prompt containing quotes or repeated whitespace was corrupted before reaching the model, and a prompt containing shell metacharacters (`;`, `&&`, backticks, …) could execute arbitrary commands. All four wrappers now pass `$ARGUMENTS` through a single-quoted heredoc, so the prompt reaches `oc.mjs` verbatim and the shell never reinterprets it.
- `--cwd` pointing at a non-existent directory failed with a bare `spawn <opencode> ENOENT` that misleadingly implicated the opencode binary; it now fails with a clear `--cwd is not an existing directory: <path>`.
- A non-object `opencode` or `retention` block in `~/.claude/oc.json` was silently discarded by `applyDefaults` before the validator ran. Config validation now runs on the raw parsed config, so a malformed block is rejected with a specific error instead of being ignored.

## 0.1.1 — 2026-05-15

Friction reduction and graceful-output pass.

- Slash-command wrappers now invoke `node` directly via here-string (`node ... <<< "$ARGUMENTS"`) instead of piping through `printf`, matching their `allowed-tools: Bash(node:*)` declaration and removing implicit `printf` permission prompts on every spawn.
- Background stderr now appears in `/oc:tail` rather than being silently dropped as malformed NDJSON.
- Finished sessions (`completed` / `failed` / `cancelled`) no longer suggest `--follow` or time out in tail.
- Runtime config validation ignores unknown keys and only checks values cc-oc itself consumes (the JSON schema remains strict for editor tooltips).
- Removed `--fresh` flag — it had no positive effect (the default is already a fresh thread; it only error-caught `--continue && --fresh`).
- Command markdown files trimmed: flag tables removed in favour of `--help` (single source of truth in `oc.mjs`).
- Fixes: `--lines 0` now returns zero events; config error messages name the actual path when `CLAUDE_HOME` is set; `findOpencodeBinary` respects the provided env when calling `which`; digest markers and session listing are ASCII-only for non-UTF terminals; quote-stripping handles here-string trailing newlines.

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
