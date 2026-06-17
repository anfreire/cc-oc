# Changelog

## 0.7.1 — 2026-06-17

- **`findSession` treats an empty id as "not found".** A blank or missing session id previously hit `startsWith("")` and matched *every* session, so `/oc:wait ""` and `/oc:cancel ""` reported `ambiguous … matches N sessions` instead of a clean miss. An early guard now returns `null` before the lookup, so all three callers (`wait` / `tail` / `cancel`) surface their normal "no session" message.
- **`marketplace.json` plugin description now lists `wait`.** It read `Spawn / tail / sessions / cancel`, omitting the `wait` command that has shipped since 0.6.0; it now matches `plugin.json`'s `Spawn / tail / wait / sessions / cancel`.

## 0.7.0 — 2026-06-17

**`/oc:wait` now returns the result; `/oc:tail` is purely an events viewer.** Reading an agent's answer used to mean `spawn → wait → tail`, but `wait` only printed a pointer and a plain `/oc:tail <id>` (default `--events 1`) rendered the terminal `step_finish` to nothing — so it came back empty on nearly every finished session and callers fell back to parsing the raw NDJSON. The two jobs are now split cleanly: `wait` gets the answer, `tail` shows the event trace.

### Changed

- **`/oc:wait <id>` prints the session's final answer.** On a clean finish it writes the model's final answer (text since the last step boundary) to stdout and exits `0`; on failure it writes `session <id> error: <message>` to stderr and exits `1`. A logged `error` event counts as a failure even when the ledger says `done`. This is the canonical "get the answer" path — background it and the completion notification carries the answer, with no separate read step. For a pure completion barrier, redirect `wait <id> > /dev/null` (errors still surface on stderr). Was: a one-line `finished — /oc:tail <id>` pointer.
- **`/oc:spawn` output reframed** around the new flow — a "Get the answer" line pointing at the backgroundable `wait`, then a "Watch or inspect events" block for `tail` / `cancel` / `sessions`.

### Fixed

- **`readDigest` renders, then slices.** `--events N` now counts *renderable* events: every event is rendered and the structural ones (`step_start` / `step_finish` / empty text) dropped before the last N are taken. A finished session ends on `step_finish`, so the old slice-then-render order made a plain `/oc:tail <id>` come back empty; the last renderable event of a finished session is now its final answer block.
- **`/oc:spawn` follow-up list now aligns with `String.padEnd`** instead of hand-counted spaces (and a `" ".repeat(id.length)` hack) that drifted as the command width varied.

### Docs

- `README.md`, `commands/{wait,tail,spawn}.md`, and the `oc.mjs` help text updated for the wait/tail split. `LogState.finalText` JSDoc corrected to "text since the most recent step boundary".

## 0.6.1 — 2026-06-06

- `/oc:sessions` and `/oc:wait` now show opencode's own generated session **title** (e.g. "Adversarial review of cc-oc wait changes") instead of a 72-char truncation of the raw prompt, read live from `opencode session list --format json`. Falls back to the prompt summary whenever a real title isn't available — opencode's `New session - <ts>` placeholder, an empty title, or any failure (binary missing, non-zero exit, bad JSON, 3s timeout). New `sessionTitles()` helper in `lib/opencode-bin.mjs`; no ledger schema change, no caching, no new deps.

## 0.6.0 — 2026-06-06

- New `/oc:wait <id>` command (and `oc.mjs wait` subcommand): blocks until a session reaches a terminal state, then prints a one-line summary — session id, short prompt, and an `/oc:tail` pointer — exiting `0` on done, `1` on error. It deliberately does not echo the session output, so backgrounding it gives a single completion notification without bloating the caller's context. Built on the same pid-liveness signal as `--follow`, so it surfaces every terminal state (done, error, crash), not just success.
- `/oc:tail` `--events` now defaults to `1` (was `10`) — a plain `/oc:tail <id>` shows just the latest event; pass `--events N` for more.
- `/oc:spawn` output now ends with a "Notify when done" line pointing at the backgrounded `wait` monitor.
- Docs: `README.md` tail section corrected (`--lines` → `--events`, default `1`) and a `/oc:wait` section added; `sucessfull` → `successful` typo swept across the command docs; assorted JSDoc / usage-string consistency fixes.

## 0.5.3 — 2026-06-01

- New `/oc:spawn --pure` flag, passed straight through to `opencode run --pure` to run without external plugins. Boolean, optional, off by default — same wiring as `--thinking`. Documented in `README.md`, `commands/spawn.md`, and the `oc.mjs` help text.

## 0.5.2 — 2026-05-30

- New bundled `reference/recovery.md` — a guide Claude reads on a failed or stalled spawn: find a valid model (`opencode models [--refresh]`) / agent (`opencode agent list`), list a model's `--variant` tiers, decode startup errors (model-not-found, insufficient-balance, auth), and handle the one failure cc-oc can't see — a provider usage limit (`429 usage_limit_reached`, retried silently inside opencode and never emitted to the `--format json` stream, so the session just sits `running`). Fixes are framed as options to offer the user, not actions to take unprompted.
- `/oc:spawn` failure output now prints a `recovery:` line with the absolute path to that guide (resolved via the script's own `import.meta.url`), so it's one Read away on any failed start. `commands/spawn.md` documents it.

## 0.5.1 — 2026-05-28

- Tail timestamps are now session-relative (`[+0:02]`, `[+5:12]`, `[+1:05:42]`) instead of wall-clock (`[HH:MM:SS]`). The base is the first event in the log; follow-mode continues the same clock.

## 0.5.0 — 2026-05-28

**Session-end detection rewritten around pid liveness. Renderer overhauled to preserve model output verbatim and to identify what tools touched.** 0.4 treated `step_finish` as a session terminator, which broke `--follow` for multi-step runs (it quit at step 1 of N) and was wrong on its premise — opencode in `--format json` mode never emits `session_idle`; the process simply exits. The truth model is now: the opencode `run` process dying *is* the session end. Events tell us what happened and whether it failed, not whether it's over.

### Fixed

- `/oc:tail --follow` no longer exits at the first `step_finish`. Multi-step runs block until the opencode child process actually exits. `followLog` polls `isPidAlive(pid)` for termination; events are read for rendering only.
- `text` and `reasoning` events are no longer clipped to 120 chars. The model's actual answer — whether 6 chars or 17 KB with 296 newlines of markdown — comes through verbatim. Single-line bodies render inline (`[ts] model: <body>`), multi-line bodies use a header + body block (`[ts] model:\n<body>`).
- `reconcileSessionState` no longer infers "done" from `step_finish`. It checks the pid first: alive → still running; dead with no error event → done; dead with an error event → error with the message.

### Changed

- `lib/events.mjs::isTerminalEvent` → `isErrorEvent`. Returns true only for `session_error` / `session.error` / `error`. `step_finish` and `session_idle` are no longer treated as session-ending.
- `lib/tail.mjs::followLog(pid, logFile, opts)` — `pid` is a mandatory first positional argument. After pid death, a final drain surfaces any trailing bytes before return.
- `lib/tail.mjs::LogState.terminalKind` → `errorSeen: boolean`, plus a new `lastEventAt: number | null` (ms epoch of the most recent event in the log).
- `step_start` / `step_finish` no longer render. Their timestamps still drive `lastEventAt`.
- `tool_use` events render as `[ts] tool: <name> <input>`. The input is picked via a priority-list heuristic (`filePath`, `path`, `file`, `command`, `pattern`, `url`, `query`, `description`, fallback to first string field as `key=value`, last-ditch compact JSON), clipped to ~120 chars. The output blob is no longer rendered — the model's subsequent `text` event surfaces anything worth saying about it.
- `/oc:tail --lines N` → `/oc:tail --events N` (it always counted events, not lines; the name now matches).
- `/oc:sessions` table: `started` column removed, `activity` column added. Activity shows the relative time of the most recent event in each session's log.
- `commands/tail.md` and `commands/sessions.md` updated for the new flag name and column layout.

## 0.4.0 — 2026-05-27

**Breaking. Complete rewrite as a thin pass-through to `opencode run`.** The 0.3.x direction (per-spawn MCP exclusion, optional config file, model/agent diagnostic subcommands, JSON output mode, sandbox flag) was scope creep on what should be a launcher. cc-oc 0.4 drops everything that isn't strictly "start opencode, track it, stream it, stop it" and exposes opencode's own flags verbatim instead of reinventing names for them.

### Surface

Four slash commands, seven spawn flags, three statuses, zero config.

- **`/oc:spawn`** — flags pass through to `opencode run` 1:1: `--dir`, `--model`, `--agent`, `--variant`, `--thinking`, `--dangerously-skip-permissions`, `--session`. All optional. Prompt body on stdin via single-quoted heredoc, same as 0.3. cc-oc waits up to a hardcoded 20s for opencode's first event, then either surfaces an error inline (and exits 1) or prints the session id and detaches.
- **`/oc:tail <id> [--follow] [--lines N]`** — session id now required (no implicit "latest in this CC session" fallback). `--lines` defaults to 10; combinable with `--follow` (last N first, then stream new). No more `--text` / `--raw` / `--since` / `--reasoning` / `--json` — events are always rendered uniformly, reasoning lines included when opencode emits them (i.e. when `--thinking` was passed to spawn).
- **`/oc:sessions`** — scoped to the current Claude Code session only. Columns: session id, started (relative time), status, prompt summary. No `--all` widening, no per-id detail view, no `--json`.
- **`/oc:cancel <id>`** — takes exactly one session id. Aborts if running, no-op otherwise. No `--all`.

### Statuses collapsed

Six statuses (`queued` / `running` / `completed` / `failed` / `cancelled` / `detached`) → three (`running` / `done` / `error`). Cancelled sessions are now `done`; the SessionEnd hook no longer mutates statuses at all (it just prunes logs). Reconcile-on-read still happens lazily when `/oc:tail` or `/oc:sessions` scans a log.

### Pending ids removed

The 20s probe extracts opencode's real session id from the first event and renames the temp log to `<sid>.ndjson` before recording the ledger entry. No more `_pending_<…>` synthetic ids, no migration logic in the reconciler, no dual `findSession` lookup. If the probe times out (no event in 20s) or the child exits without producing events, cc-oc kills the process group and exits 1 instead of leaving a pending row.

### Typed event schema

New `lib/events.mjs` ships a JSDoc discriminated union (`OpenCodeEvent`) covering the eight kinds opencode emits (`StepStartEvent`, `StepFinishEvent`, `TextEvent`, `ToolUseEvent`, `ReasoningEvent`, `SessionIdleEvent`, `SessionErrorEvent`, `ErrorEvent`) plus cc-oc's synthesised `StderrEvent` for unparseable lines. `renderEvent` switches on `event.type` against this union; unknown event types fall through to a `[ts] <type>` line so the stream stays informative when opencode adds new event kinds. `isTerminalEvent` is exported from the same module and used by the spawn probe and the tail reconciler.

### Dropped

- **Config file (`~/.claude/oc.json`).** Defaults are sufficient; users configure opencode itself.
- **`lib/config.mjs`, `lib/builder.mjs`, `lib/args.mjs`, `lib/render.mjs`, `schemas/oc.config.schema.json`** — gone (renderer folded into `tail.mjs`; minimal arg parser inlined into `oc.mjs`).
- **`models` and `agents` diagnostic subcommands.** Whitespace-decides natural-language hints are now the user's problem; opencode's own error messages (which include "Did you mean: …" suggestions) are surfaced verbatim.
- **Per-spawn MCP exclusion (`--exclude-mcp` / `--include-mcp`)** and the `OPENCODE_CONFIG_DIR` override-writing machinery. Users who want per-spawn MCP control can manage it in their opencode config.
- **`--read-only` / `--write` sandbox flag** — replaced by direct `--dangerously-skip-permissions` pass-through.
- **`--provider` / `--model` pairing** — opencode's `--model` already takes the `provider/model` form; cc-oc passes it through verbatim.
- **`--pure`, `--project` / `--no-project`, `--wait-ms`, `--no-wait`, `--continue`, `--json`** spawn flags.
- **`--text`, `--raw`, `--since`, `--reasoning`, `--json`** tail flags.
- **`--all`, `--workspace`** sessions/cancel widening flags.
- **`--json`** output mode on every command.
- **`detached` status, the `gc` hook's status-detach pass.** Logs are pruned on SessionEnd; statuses are reconciled lazily on the next read.
- **`oc-delegate` subagent.** The plugin now ships only the four slash commands. Callers who want context-firewall forwarding can spawn a session and tail it themselves.

### Migration

There is no migration path. The ledger format, command surface, and flag names are all incompatible with 0.3. If you've been running 0.3, `rm -rf ~/.claude/plugins/data/oc/` before upgrading.

## 0.3.0 — 2026-05-26

`/oc:spawn` is fire-and-forget detached. cc-oc spawns opencode with `detached: true` + file-fd stdio, awaits the child's `spawn` / `error` event to detect a stillborn exec, then `child.unref()`s and exits. The bash call returns in milliseconds with a started-session block (pid, pending session id, log path, four follow-up commands); opencode keeps running in its own process group, writing NDJSON events to the log file. To wait for the result, the caller runs `/oc:tail <id> --follow`, which blocks on the log's terminal event (`step_finish` / `session_idle`) and exits. Adds the symmetric `agents` diagnostic and folds in correctness/clarity fixes from multiple rounds of post-0.2.0 review.

### New

- **`oc.mjs agents` diagnostic.** Symmetric with `oc.mjs models`: lists opencode-resolved agents (built-ins + global config + project config + plugin packages, all merged by opencode itself) so Claude can resolve a natural-language hint ("the build agent") into a real id before spawning, and can suggest alternatives after opencode rejects an unknown agent name. cc-oc shells out to `opencode agent list` and re-emits just the name + kind per line — no permission JSON noise. Flags: `--match "<hint>"` (token-ranked filter, shared scoring helpers with `models`) and `--json`. `spawn.md` extends the existing whitespace-decides rule to cover `--agent` and gives the recovery procedure.

### Changed

- **Single execution mode.** `lib/spawn.mjs::startSpawn` is the sole exported entry point: detached spawn, file-fd stdio, await `spawn`/`error`, `child.unref()`, exit. No pipe-based blocking path, no signal trap, no kill-recovery machinery — one path through `cmdSpawn`. The bash call is short-lived; opencode survives whatever happens to its parent.
- **No exit-code propagation from opencode.** cc-oc returns before opencode finishes, so it cannot return opencode's runtime exit code. The reconciler picks up failures lazily — `/oc:tail`, `/oc:sessions`, and the SessionEnd `gc` hook scan the log for `session_error` / `error` events and mark the ledger entry `failed`.
- **`jobClass` field removed from new ledger entries.** With one execution mode there is nothing to classify. The `/oc:sessions` display is now `[<status>]`. Old entries with the field set are still readable; the display ignores it.
- **`commands/spawn.md` rewritten** for the new lifecycle. Output rules: relay the started-session block, then either run `/oc:tail --follow` (if the user wants the result) or end the turn (if they kicked off and moved on).
- **`agents/oc-delegate.md` rewritten** for the new lifecycle. The subagent now makes two Bash calls in sequence — `oc.mjs spawn` (returns immediately with the session id) then `oc.mjs tail <id> --follow` (blocks until terminal). Single return shape: opencode's final assistant text + 1–2 line summary.

### Fixed

- `spawn --help` no longer drains stdin before printing help. `main()` now scans `rest` for `--help`/`-h` and skips `readPromptFromStdin` when present (would otherwise block on `spawn --help < /dev/null` or `spawn --help <<EOF…EOF`).
- All string-valued spawn flags reject empty values explicitly. `--provider= --model= --agent= --variant= --cwd= --continue= --exclude-mcp= --include-mcp=` now error with `--<flag> value must be a non-empty string` instead of silently falling through to the configured default. Replaces the v0.2.0 ad-hoc check that only covered provider/model.
- `startSpawn` no longer hangs on spawn errors. ENOENT / EPERM / etc. emit `error` without a subsequent `spawn`; the await on the spawn/error race resolves on either, with a `spawnError` field on the failure path, after logging the failure to the pending log so the reconciler can mark the entry `failed`.
- `tail --follow` now honours `--json` and reconciles the ledger after the log shows terminal events. Previously the follow branch returned before the JSON envelope path and ignored `result.terminal`, leaving callers without the structured output they asked for and the entry stuck in `running` until some later `tail` / `sessions` call.
- `oc.mjs models` and `oc.mjs agents` reject stray positional tokens **and** empty `--match` / `--provider` values. Previously `models --match deep seek` parsed `--match deep` and silently dropped `seek`; `models --match=` silently behaved like bare `models`. Both subcommands now error with a quotation hint or a non-empty-string message.
- `/oc:tail`, `/oc:sessions`, and `/oc:cancel` reject extra positional tokens. Previously `/oc:cancel ses_a ses_b` cancelled only `ses_a` and silently ignored `ses_b`; now it errors with an explicit message.
- `/oc:sessions <id>` now resolves a pending id and reconciles the entry from its log before printing. Previously the single-id lookup returned the raw ledger record while the list path reconciled — a completed session inspected by id could still show `running` / `pending`.
- **Recovery commands using the pending session id stay valid after migration.** `resolvePendingSession` now preserves the original pending id on the migrated record (new `pendingId` field), and `findSession` matches against either `sessionId` or `pendingId` (exact then prefix). Previously a `/oc:cancel <pendingId>` from the original started-session block returned not-found after any prior `/oc:tail` had migrated the entry to its real opencode session id.
- `cmdGc` pre-reconciles candidates before marking them `detached` on SessionEnd. Previously a session that finished cleanly but whose reconcile happened to miss could be flipped to `detached` (terminal) and frozen out of future `completed`/`failed` transitions. `gc` now calls `resolvePendingSession` + `reconcileSessionState` on each running/queued candidate first, outside the ledger lock, then takes the lock once for the residual detach pass.
- `spawn.md` no longer silently drops `--model` when the user names a model without a provider. The natural-language mapping for *"use model X"* now tells Claude to **ask** which provider rather than falling back to opencode's default.
- `cmdSpawn` surfaces `startSpawn`'s `spawnError` payload (ENOENT/EPERM at exec time) with a clear `oc: opencode child failed to start: <code>` message and a pointer to the pending log's `SpawnError` event. Under `--json`, returns `{started: false, spawnError, pendingId, pendingLog}`.
- All empty-string checks for flag values now also reject whitespace-only values. `--match "   "`, `--provider "   "`, `--agent "   "`, etc. used to pass the truthy / non-empty-only guards and silently fall back to the default-no-filter path. They now error with `--<flag> value must be a non-empty string`.
- Token-similarity scoring (`scoreOf`, shared by `models` and `agents`) now requires both the hint token AND the candidate token to be ≥ 2 chars before awarding the 0.5 substring-overlap score. A one-letter hint like `a` previously scored 0.5 against every candidate containing the letter, drowning real matches in noise.
- Partial fd-open failure in `startSpawn` no longer leaks the first descriptor when the second `fs.openSync` throws. The catch arm now closes `out` before rethrowing.
- `startSpawn` no longer leaks the parent's log fds if `spawn()` itself throws synchronously (e.g., invalid options). The fd-close calls are now in a `try/finally` after the spawn, so they run on the sync-throw path too — complementing the partial-open fix above.
- `cancelSession` now signals opencode's whole process group (`process.kill(-pid, …)`) instead of just the leader. With `startSpawn` running opencode as the leader of its own process group (`detached: true`), the previous `process.kill(pid, …)` could leave MCP-server / tool subprocesses orphaned after a `/oc:cancel`.

### Known limitations

- **`startSpawn` uses Node's `detached: true`,** which on Windows means "separates the console" rather than "creates a new POSIX session". cc-oc targets Linux/macOS (opencode does too), so the signal-isolation guarantee documented in the code header is specifically a POSIX property. We do not currently refuse to run on Windows, nor do we adjust the spawn flags for it.
- **`oc.mjs agents` parses headers matching `[A-Za-z0-9._-]+ (primary|subagent)`** — the format `opencode agent list` emits in current opencode versions. If opencode ever introduces agent names with spaces, parentheses, or other punctuation, those entries will be silently skipped by both bare-list and `--match` modes (they share the same regex). Users would need to call `opencode agent list` directly to see those names.
- **Two sub-millisecond race windows remain.** They are pre-existing and have not been observed in practice, but documented here for completeness: (1) two concurrent `/oc:tail`/`/oc:sessions` calls hitting the same pending session can in principle each push a new row for the same session id before the other's `saveIndex` lands (`resolvePendingSession` filters only by the stale pending id, not by log file); (2) `cmdGc`'s pre-reconcile pass and locked detach pass are sequential — if a terminal log event arrives between them, `gc` can still mark the entry `detached`.

### Polish

- Slash-command MDs (`spawn.md`, `tail.md`, `sessions.md`, `cancel.md`) rewritten for clarity. spawn.md replaces the indented-heredoc example block with a 3-column parse table (user input / flags / prompt body), spells out the disambiguation rule for flag-shaped tokens (known-as-prompt, known-as-control, unknown), and tells Claude to **ask the user** on ambiguity rather than silently swallowing typos. tail/sessions/cancel each get explicit "tokenize whitespace-separated, respecting quotes" instructions plus an example-parse table.
- `oc-delegate.md` rewritten end-to-end for the spawn-then-tail-follow flow. Two ordered Bash calls; one return shape; the 1–2 line summary is the only commentary.
- `oc.mjs spawn --help` documents the new always-detached behaviour and the four follow-up commands. Recovery section covers the agent diagnostic alongside model/provider.
- `hooks.json` description matches what `gc` actually does (mark every still-running cc-oc session in this CC session as detached, then prune).
- `oc.config.schema.json` no longer references standalone `--model` (paired with `--provider` since v0.1.4).
- README quick-start, command table, models/agents sections, "How it works" sketch, "Background jobs at CC session end" section, and troubleshooting list updated to match the always-detached surface; trust-model note explains that the slash wrappers instruct Claude to wrap the prompt in a single-quoted heredoc rather than the old "wrappers pipe `$ARGUMENTS` to stdin" mechanism.
- Removed: dead `splitRawArgumentString` export from `lib/args.mjs`; dead `extra` parameter in `buildCliArgs`; `runsDir` export from `builder.mjs` (only used inside the module); `runForeground` and `runBlockingBg` from `lib/spawn.mjs` (replaced by `startSpawn`).
- `cmdGc`'s SessionEnd hook timeout bumped from 8s to 20s. The new pre-reconcile pass synchronously scans each candidate log file, and with many large pending entries the old budget could time out before the locked detach pass ran.
- Agent header regex in `cmdAgents` now accepts `.` (provider-style ids) in addition to alphanumerics, `_`, and `-`. Pre-emptive — current opencode versions emit only alphanumeric ids, but the parser was unnecessarily narrow.
- README's `oc-delegate` description matches the updated subagent spec — "starts one delegated opencode session via `/oc:spawn`, waits for it via `/oc:tail --follow`, and returns opencode's final assistant message verbatim plus a 1–2 line summary".
- Started-session block (the only output of `/oc:spawn`) is written in cc-oc's after-the-fact voice: it tells Claude that opencode is running detached, that cc-oc has exited, and which of the four follow-up commands to compose next depending on what the user asked for. spawn.md's Output rules section mirrors this.

## 0.2.0 — 2026-05-26

**Breaking.** One transport convention for `oc.mjs spawn`: argv carries flags only, the prompt body is piped on stdin. No more ` -- ` separator, no `--stdin` / `--prompt-stdin` flags. The whole class of "Claude composed the wrong shape" failures from v0.1.5 / v0.1.6 disappears — there's only one shape now.

- **`oc.mjs spawn` rewritten.** Reads the prompt body from stdin (required); any leftover argv token after the known flags is an error pointing at the new shape. The v0.1.5 fail-fast for the missing ` -- ` separator is gone — there is no separator anymore. Removed: `splitFlagsAndPrompt`, `stripPromptShell`, `readArgsFromStdin`, and the `--stdin` / `--prompt-stdin` branches in `main()`. Added: a small `readPromptFromStdin` helper called only for `spawn`.
- **Slash commands rewritten as parse-then-compose instructions.** `spawn.md`, `tail.md`, `sessions.md`, `cancel.md` no longer embed a fixed bash template; they tell Claude to parse `$ARGUMENTS` into argv tokens and (for spawn) a prompt body, then compose the `node oc.mjs ...` call directly. The slash-command harness already routes every invocation through Claude, so parsing happens in the LLM step that was already there — no hidden server-side state.
- **User-typed slash form: no separator.** Was: `/oc:spawn --bg -- "review the diff"`. Now: `/oc:spawn --bg review the diff`. Everything after the recognised flags is the prompt body, preserved verbatim through the single-quoted heredoc.
- **`oc-delegate` aligned.** Drops `--prompt-stdin`; uses the bare-stdin heredoc shape (same one direct callers use).
- **README quick-start and command examples updated** to the no-separator form.

Migration: if you call `oc.mjs` directly from a script, drop any `--stdin` / `--prompt-stdin` flag and stop fusing the prompt into argv. The shape is now `oc.mjs spawn [flags] <<EOF\n<prompt>\nEOF`. Slash-command users see the new form automatically — the wrappers handle parsing.

## 0.1.6 — 2026-05-26

Teach Claude two distinct `oc.mjs` invocation shapes so autonomous spawns stop tripping the v0.1.5 fail-fast.

- **`spawn.md` now documents `--stdin` and `--prompt-stdin` as non-interchangeable shapes**, with a rule for picking between them: `--stdin` belongs *only* in the `/oc:spawn` slash-command wrapper (where `$ARGUMENTS` arrives as one textual blob and ` -- ` separates flags from prompt); `--prompt-stdin` is the shape to use when Claude itself composes the bash call (flags in argv, prompt body alone in the heredoc, no ` -- ` anywhere). Direct-Bash invocations with `--stdin` were the recurring source of `missing ` -- ` separator before prompt …` errors from v0.1.5 — Claude was mimicking the slash-command "Run" template and forgetting that the ` -- ` is what the *user* types in the slash form, not something to fabricate from thin air. `--prompt-stdin` has no equivalent failure mode.
- **`oc-delegate.md` flag examples updated** for the v0.1.4 `--provider`+`--model` split (was still showing the singular pre-split `--model`).

No code changes.

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
