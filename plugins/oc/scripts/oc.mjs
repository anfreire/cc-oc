#!/usr/bin/env node
// Main dispatcher for the oc plugin.
// Subcommands: spawn | tail | sessions | cancel | gc | models | agents

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { parseArgs, splitCsv } from "./lib/args.mjs";
import { loadUserConfig, validateConfig } from "./lib/config.mjs";
import { buildConfigDir } from "./lib/builder.mjs";
import { startSpawn, resolvePendingSession, reconcileSessionState } from "./lib/spawn.mjs";
import { readDigest, followLog } from "./lib/tail.mjs";
import { findOpencodeBinary } from "./lib/opencode-bin.mjs";
import {
  loadIndex,
  saveIndex,
  upsertSession,
  findSession,
  listSessions,
  latestActiveSession,
  logFileFor,
  pluginDataRoot,
  withLedgerLock
} from "./lib/ledger.mjs";

const SUBCMDS = new Set(["spawn", "tail", "sessions", "cancel", "gc", "models", "agents"]);
const DONE_STATUSES = new Set(["completed", "failed", "cancelled"]);

function die(msg, code = 1) {
  process.stderr.write(`oc: ${msg}\n`);
  process.exit(code);
}

function parseNonNegativeIntFlag(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    die(`${label} must be a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return n;
}

function ccSessionIdFromEnv() {
  // Claude Code exposes the active session id as CLAUDE_CODE_SESSION_ID; that is
  // what scopes /oc:sessions, /oc:tail, /oc:cancel, and the gc hook to "this CC
  // session". CC_SESSION_ID / OC_PLUGIN_SESSION_ID remain as manual overrides.
  return (
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.CC_SESSION_ID ||
    process.env.OC_PLUGIN_SESSION_ID ||
    null
  );
}

// Best-effort cancel: ask OpenCode to abort the session in its own DB first,
// then SIGTERM our tracked PID if any, then mark the ledger entry cancelled.
function cancelSession(rec, env) {
  // OpenCode session abort: only meaningful when we have a real (non-pending) id.
  if (rec.sessionId && !rec.pending && !rec.sessionId.startsWith("_pending_")) {
    const bin = findOpencodeBinary({ env });
    if (bin) {
      try {
        spawnSync(bin, ["session", "abort", rec.sessionId], { env, stdio: "ignore", timeout: 5000 });
      } catch { /* best effort */ }
    }
  }
  if (rec.pid) {
    // Signal the whole process group, not just the leader. `startSpawn` runs
    // opencode with `detached: true` so it sits as the leader of its own
    // session/group; `process.kill(-pid, …)` reaches any MCP-server / tool
    // subprocesses opencode forked. `process.kill(pid, …)` would only hit
    // the leader and orphan the rest.
    try { process.kill(-rec.pid, "SIGTERM"); } catch { /* may already be dead */ }
  }
  // pending: false matters here — without it, an entry's pending=true would
  // make reconcileSessionState consider this record "active" and overwrite
  // status="cancelled" with "completed" the moment a step_finish event lands
  // in the log (which can happen if opencode finishes its work the same
  // millisecond we sent SIGTERM).
  upsertSession({
    sessionId: rec.sessionId,
    status: "cancelled",
    pending: false,
    completedAt: new Date().toISOString()
  }, env);
}

// Per-subcommand help text. Printed when --help or -h appears among the flag
// tokens (anything before the `--` boundary). Lets a confused LLM caller learn
// the flag surface at runtime rather than only from the slash-command markdown.
const HELP_TEXTS = {
  spawn: `oc.mjs spawn [flags] <<EOF
<prompt body>
EOF

argv carries flags only. The prompt body is read from stdin (always required).
There is no ` + "`--`" + ` separator and no flag for stdin; piping a prompt body in
is the only way to pass one.

Spawn always runs detached. cc-oc starts opencode, prints a started-session
block with the pid and pending session id, then exits — opencode continues in
its own process group, writing NDJSON events to the per-session log file. To
wait for opencode to finish, run \`/oc:tail <id> --follow\`; to peek at progress,
\`/oc:tail <id>\`; to abort, \`/oc:cancel <id>\`.

Flags:
  --read-only         Default sandbox; opencode's own permission gating applies
  --write             Pass --dangerously-skip-permissions to opencode
  --provider <name>   Provider name (required with --model)
  --model <id>        Model id (required with --provider)
  --variant <name>    Model variant (e.g. reasoning-effort tier)
  --agent <name>      Pin a specific opencode agent for this spawn
  --cwd <path>        Workspace root (default: current directory)
  --continue <sid>    Resume a previous opencode session
  --exclude-mcp <csv> Disable these MCP servers for this spawn
  --include-mcp <csv> Re-enable these (escape hatch for globally-excluded servers)
  --pure / --no-pure  Skip / include opencode's external plugins
  --project / --no-project  Include / skip <cwd>/.opencode/
  --json              Machine-readable started-session block

Recovery:
  cc-oc does not preflight model / provider / agent strings — opencode
  validates them. After a spawn fails on an unknown one, run the matching
  diagnostic to list candidates (always quote multi-word values):
    oc.mjs models --match "<hint>"            (search models across providers)
    oc.mjs models --provider "<name>"         (list one provider's models)
    oc.mjs models --provider "<name>" --match "<hint>"   (ranked within provider)
    oc.mjs agents --match "<hint>"            (rank agents by hint)
    oc.mjs agents                             (bare list of all agents)
`,
  tail: `/oc:tail [session-id] [flags]

  <session-id>  Full id or unique prefix; omit for the latest active in this CC session
  --follow      Block until terminal (max 15 min)
  --lines N     Only the last N events
  --since <ms>  Filter events newer than the given timestamp
  --reasoning   Include thinking lines
  --raw         Emit raw NDJSON instead of digest
  --json        Wrap result in JSON envelope
`,
  sessions: `/oc:sessions [session-id] [flags]

  <session-id>  Detailed snapshot (full id or unique prefix)
  --all         Widen to other CC sessions in this workspace
  --json        Machine-readable output
`,
  cancel: `/oc:cancel <session-id> | --all [flags]

  <session-id>  Cancel that specific session
  --all         Cancel every running session in this CC session
  --workspace   Combined with --all: widen to current workspace
  --json        Machine-readable result
`,
  models: `oc.mjs models [flags]

Diagnostic. Lists providers/models from opencode's own registry:
  ~/.cache/opencode/models.json    (opencode-managed cache; populated by running opencode)
  ~/.config/opencode/opencode.json (user-defined custom providers under .provider.*.models)

Two use cases (both Claude-facing — do not invoke this on every spawn):
  - BEFORE spawning, when the user wrote the model or provider with whitespace
    ("the DeepSeek flash model") — translate the natural-language hint into a
    real id with --match, confirm with the user, then spawn.
  - AFTER a spawn fails on an unknown model or provider (typo recovery).
  For no-whitespace canonical ids, NEVER preflight; pass through verbatim.

  (no flags)            list providers and model counts
  --provider <name>     list models for that provider
  --match <hint>        rank candidates by token match (across all providers,
                        or within --provider when both are given)
  --json                machine-readable output
`,
  agents: `oc.mjs agents [flags]

Diagnostic. Lists opencode-resolved agents (built-ins, global config, project
config, plugin packages — all merged by opencode itself). cc-oc shells out to
\`opencode agent list\` and re-emits just the name + kind per line, stripping
the permission JSON noise.

Use this when the user named an agent with whitespace (natural-language hint)
or when opencode rejected a no-whitespace agent name (typo recovery).

  (no flags)        list all agents alphabetically, with kind
  --match <hint>    rank agents by token match against the hint
  --json            machine-readable output
`
};

function maybePrintHelp(name, argv) {
  for (const t of argv) {
    if (t === "--") return false;
    if (t === "--help" || t === "-h") {
      process.stdout.write(HELP_TEXTS[name]);
      return true;
    }
  }
  return false;
}

function applySpawnOverrides(config, flags) {
  const cfg = structuredClone(config);
  cfg.opencode = cfg.opencode ?? {};
  if (flags["read-only"]) cfg.opencode.sandbox = "read-only";
  if (flags.write)        cfg.opencode.sandbox = "workspace-write";
  if (flags.model)        cfg.opencode.model = flags.model;
  if (flags.variant)      cfg.opencode.variant = flags.variant;
  if (flags.agent)        cfg.opencode.agent = flags.agent;
  // Boolean flags: distinguish unset (undefined) from explicit false (--no-pure).
  if (flags.pure !== undefined) cfg.opencode.pure = flags.pure;
  // `project` is the positive flag; `--no-project` -> false (disableProjectConfig).
  if (flags.project !== undefined) cfg.opencode.disableProjectConfig = !flags.project;

  // Per-spawn MCP exclusion. `--exclude-mcp` adds names to the configured
  // excludeMcps list; `--include-mcp` removes names from it (escape hatch for
  // re-enabling a server you've disabled globally for one specific run).
  // exclude is applied first so include can countermand it within the same
  // call — `--exclude-mcp foo --include-mcp foo` is a no-op rather than
  // order-dependent.
  if (flags["exclude-mcp"]) {
    const names = splitCsv(flags["exclude-mcp"]);
    const merged = new Set([...(cfg.opencode.excludeMcps ?? []), ...names]);
    cfg.opencode.excludeMcps = [...merged];
  }
  if (flags["include-mcp"]) {
    const remove = new Set(splitCsv(flags["include-mcp"]));
    const current = Array.isArray(cfg.opencode.excludeMcps) ? cfg.opencode.excludeMcps : [];
    cfg.opencode.excludeMcps = current.filter((n) => !remove.has(n));
  }
  return cfg;
}

// ─── spawn ──────────────────────────────────────────────────────────────────
async function cmdSpawn(argv, prompt) {
  if (maybePrintHelp("spawn", argv)) return;
  const { flags, positionals, rest } = parseArgs(argv, {
    "read-only": { type: "boolean" },
    "write":     { type: "boolean" },
    "provider":  { type: "string" },
    "model":     { type: "string" },
    "variant":   { type: "string" },
    "agent":     { type: "string" },
    "cwd":       { type: "string" },
    "continue":  { type: "string" },
    "exclude-mcp": { type: "string" },
    "include-mcp": { type: "string" },
    "pure":      { type: "boolean" },
    "project":   { type: "boolean" },
    "json":      { type: "boolean" }
  });

  // argv carries flags only. Any leftover token means the caller mixed the
  // prompt into argv — most likely an old-shape invocation from before v0.2.0,
  // when ` -- ` separated flags from prompt. Point at the new shape rather
  // than silently joining tokens.
  const stray = [...positionals, ...rest];
  if (stray.length) {
    die(`unexpected argv token(s) after flags: ${JSON.stringify(stray.join(" "))} — argv carries flags only; pipe the prompt body on stdin: \`oc.mjs spawn [flags] <<EOF\\n<prompt>\\nEOF\``);
  }

  // Reject empty-string AND whitespace-only values for ANY string-valued
  // flag. parseArgs allows `--flag=` (empty value) and `--flag "   "`
  // (whitespace), and downstream truthy / non-empty-only checks would
  // otherwise let those fall through to the configured default — silently
  // ignoring the user's intent to override. Centralised here so every
  // string flag is covered identically.
  const STRING_FLAGS = ["provider", "model", "variant", "agent", "cwd", "continue", "exclude-mcp", "include-mcp"];
  for (const f of STRING_FLAGS) {
    const v = flags[f];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.trim() === "") {
      die(`--${f} value must be a non-empty string`);
    }
  }

  // --provider and --model: must be specified together, combined into provider/model.
  if (flags.provider && !flags.model) die("--provider requires --model");
  if (flags.model && !flags.provider) die("--model requires --provider");
  if (flags.provider && flags.model) {
    flags.model = `${flags.provider}/${flags.model}`;
  }

  if (typeof prompt !== "string" || prompt.trim() === "") {
    die("missing prompt — spawn reads the prompt body from stdin: `oc.mjs spawn [flags] <<EOF\\n<prompt>\\nEOF`");
  }
  const promptBody = prompt.replace(/\n+$/, "");

  const env = process.env;
  const { config, rawConfig, source } = loadUserConfig({ env });
  const cfgValid = validateConfig(rawConfig ?? config);
  if (!cfgValid.ok) {
    die(`${source ?? "oc config"} is invalid:\n  - ${cfgValid.errors.join("\n  - ")}`);
  }

  const effective = applySpawnOverrides(config, flags);
  const sandbox = effective.opencode.sandbox || "read-only";

  const bin = findOpencodeBinary({ env });
  if (!bin) die("opencode binary not found on PATH. Install it (`curl -fsSL https://opencode.ai/install | bash`) and rerun.");

  const cwd = flags.cwd || process.cwd();
  // A bad --cwd would otherwise surface as a bare `spawn <opencode> ENOENT`,
  // which misleadingly points at the binary rather than the missing directory.
  if (flags.cwd) {
    let st = null;
    try { st = fs.statSync(cwd); } catch { /* missing */ }
    if (!st || !st.isDirectory()) die(`--cwd is not an existing directory: ${cwd}`);
  }
  const built = buildConfigDir({ config: effective, env });

  // Start opencode detached and return immediately. cc-oc awaits only the
  // child's `spawn` (success) or `error` (ENOENT/EPERM/etc.) event, then
  // unrefs and resolves; opencode continues writing NDJSON events to the
  // log file long after cc-oc has exited.
  const result = await startSpawn({
    binary: bin,
    prompt: promptBody,
    configDir: built.configDir,
    model: effective.opencode.model || undefined,
    variant: effective.opencode.variant || undefined,
    agent: effective.opencode.agent || null,
    cwd,
    sandbox,
    continueId: flags.continue || null,
    pure: Boolean(effective.opencode.pure),
    ccSessionId: ccSessionIdFromEnv(),
    env,
    disableProjectConfig: Boolean(effective.opencode.disableProjectConfig)
  });

  if (result.spawnError) {
    const code = result.spawnError.code || result.spawnError.message || String(result.spawnError);
    if (flags.json) {
      process.stdout.write(JSON.stringify({
        started: false,
        spawnError: code,
        pendingId: result.pendingId,
        pendingLog: result.pendingLog
      }, null, 2) + "\n");
    } else {
      process.stderr.write(`oc: opencode child failed to start: ${code}\n`);
      process.stderr.write(`    See pending log for the SpawnError event: ${result.pendingLog}\n`);
    }
    process.exit(1);
  }

  // Emit the started-session block and exit. The bash call returns; opencode
  // runs detached. Whether the caller waits for the result, peeks, or moves
  // on is their choice — the four /oc:* commands below are the entire
  // interface.
  const { pid, pendingId, pendingLog, configDir } = result;
  const tailRef     = `/oc:tail ${pendingId}`;
  const followRef   = `/oc:tail ${pendingId} --follow`;
  const cancelRef   = `/oc:cancel ${pendingId}`;
  const sessionsRef = `/oc:sessions ${pendingId}`;
  const guidance = [
    "opencode is running detached; cc-oc has exited and the child continues",
    "in its own process group, writing NDJSON events to the log above.",
    "",
    "Next:",
    `  ${tailRef}              peek at the current digest`,
    `  ${followRef}     block until opencode finishes (max 15 min)`,
    `  ${cancelRef}             abort the session`,
    `  ${sessionsRef}          full status snapshot`,
    "",
    `If the user asked for the result, follow with \`${followRef}\` now.`,
    "If they kicked off and moved on, end your turn — the log persists and",
    `they can pull it any time with \`${tailRef}\`.`,
    "",
    "The id above stays valid for the lifetime of the ledger entry — even",
    "after the ledger migrates from the pending id to the real opencode",
    "session id, both ids resolve to the same record."
  ].join("\n");

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      started: true,
      pid,
      pendingId,
      pendingLog,
      configDir,
      next: {
        tail: tailRef,
        follow: followRef,
        cancel: cancelRef,
        sessions: sessionsRef
      }
    }, null, 2) + "\n");
  } else {
    process.stdout.write(`Started OpenCode session.\n`);
    process.stdout.write(`  pid:     ${pid}\n`);
    process.stdout.write(`  session: ${pendingId}\n`);
    process.stdout.write(`  log:     ${pendingLog}\n`);
    process.stdout.write(`\n${guidance}\n`);
  }
}

// ─── tail ───────────────────────────────────────────────────────────────────
async function cmdTail(argv) {
  if (maybePrintHelp("tail", argv)) return;
  const { flags, positionals } = parseArgs(argv, {
    "follow":    { type: "boolean", alias: "f" },
    "lines":     { type: "string" },
    "since":     { type: "string" },
    "reasoning": { type: "boolean" },
    "raw":       { type: "boolean" },
    "json":      { type: "boolean" }
  });
  if (positionals.length > 1) {
    die(`unexpected extra token(s) after session id: ${JSON.stringify(positionals.slice(1).join(" "))} — tail accepts at most one session id`);
  }

  const env = process.env;
  const arg = positionals[0];
  let record;
  if (arg) {
    record = findSession(arg, env);
    if (!record) die(`no session matches "${arg}"`);
  } else {
    record = latestActiveSession({ ccSessionId: ccSessionIdFromEnv(), workspace: process.cwd() }, env);
    if (!record) die("no active session in this workspace. Pass a session id or start one with /oc:spawn.");
  }

  // If still pending (no sessionId observed yet), try to migrate.
  if (record.pending) {
    const resolved = resolvePendingSession(record, env);
    if (resolved) record = findSession(resolved, env) ?? record;
  }
  // Reconcile: if the log has a terminal event, mark the session completed.
  record = reconcileSessionState(record, env);

  const logFile = record.logFile || (record.sessionId ? logFileFor(record.sessionId, env) : null);
  if (!logFile || !fs.existsSync(logFile)) {
    // Fallback: ask OpenCode itself for the session state. Useful when the user
    // resumed a session we didn't spawn, or `/oc:reset --logs` was run.
    if (record.sessionId && !record.sessionId.startsWith("_pending_")) {
      const bin = findOpencodeBinary({ env });
      if (bin) {
        const r = spawnSync(bin, ["session", "get", record.sessionId], { env, encoding: "utf8", timeout: 10000 });
        if (r.status === 0) {
          if (flags.json) {
            process.stdout.write(r.stdout);
            return;
          }
          process.stdout.write(r.stdout);
          process.stdout.write(`\n(local log missing; output is from \`opencode session get\`)\n`);
          return;
        }
      }
    }
    die(`no log file for session ${record.sessionId}`);
  }

  if (flags.raw) {
    process.stdout.write(fs.readFileSync(logFile, "utf8"));
    return;
  }

  if (flags.follow) {
    // Already terminal — short-circuit. Emit the final state in the form
    // the caller asked for (digest by default, JSON envelope under --json).
    if (DONE_STATUSES.has(record.status)) {
      const { digest, eventCount } = readDigest(logFile, { lines: null, since: null, reasoning: Boolean(flags.reasoning) });
      if (flags.json) {
        process.stdout.write(JSON.stringify({
          sessionId: record.sessionId,
          status: record.status,
          eventCount,
          terminal: true,
          digest
        }, null, 2) + "\n");
      } else {
        process.stdout.write(digest);
        if (digest && !digest.endsWith("\n")) process.stdout.write("\n");
      }
      return;
    }
    // Live follow. Under --json, suppress per-line streaming via an onLine
    // sink so the final envelope is the only thing on stdout.
    const result = await followLog(logFile, {
      reasoning: Boolean(flags.reasoning),
      onLine: flags.json ? () => { /* drop */ } : null
    });
    if (result.timedOut) die(`tail timed out after 15 min`);
    // The log now contains terminal events. Re-reconcile so the ledger
    // status reflects completed / failed before we return (and so a later
    // /oc:sessions on the same record reports the right state).
    record = reconcileSessionState(record, env);
    if (flags.json) {
      const { digest, eventCount } = readDigest(logFile, { lines: null, since: null, reasoning: Boolean(flags.reasoning) });
      process.stdout.write(JSON.stringify({
        sessionId: record.sessionId,
        status: record.status,
        eventCount,
        terminal: true,
        digest
      }, null, 2) + "\n");
    }
    return;
  }

  const lines = parseNonNegativeIntFlag(flags.lines, "--lines");
  const since = parseNonNegativeIntFlag(flags.since, "--since");
  const { digest, terminal: logTerminal, eventCount } = readDigest(logFile, { lines, since, reasoning: Boolean(flags.reasoning) });
  const terminal = logTerminal || DONE_STATUSES.has(record.status);

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      sessionId: record.sessionId,
      status: record.status,
      eventCount,
      terminal,
      digest
    }, null, 2) + "\n");
    return;
  }

  process.stdout.write(digest);
  if (digest && !digest.endsWith("\n")) process.stdout.write("\n");
  if (!terminal) process.stdout.write(`\n(session still running; use --follow to wait)\n`);
}

// ─── sessions ───────────────────────────────────────────────────────────────
async function cmdSessions(argv) {
  if (maybePrintHelp("sessions", argv)) return;
  const { flags, positionals } = parseArgs(argv, {
    "all":  { type: "boolean" },
    "json": { type: "boolean" }
  });
  if (positionals.length > 1) {
    die(`unexpected extra token(s) after session id: ${JSON.stringify(positionals.slice(1).join(" "))} — sessions accepts at most one session id`);
  }

  const env = process.env;
  const cc = ccSessionIdFromEnv();

  if (positionals[0]) {
    let rec = findSession(positionals[0], env);
    if (!rec) die(`no session "${positionals[0]}"`);
    // Resolve a still-pending id to its real opencode session id (if the
    // log has the first session event), then reconcile so the status field
    // reflects what the log actually shows. Without this, /oc:sessions <id>
    // returned a stale `running` / pending row for a job that had long
    // finished — the list path reconciles, but the single-id lookup didn't.
    if (rec.pending) {
      const resolved = resolvePendingSession(rec, env);
      if (resolved) rec = findSession(resolved, env) ?? rec;
    }
    rec = reconcileSessionState(rec, env);
    process.stdout.write(JSON.stringify(rec, null, 2) + "\n");
    return;
  }

  // Scope ladder mirrors /oc:cancel:
  //   default → this CC session, this workspace
  //   --all   → this workspace, every CC session (drop the ccSessionId filter)
  // No global option here — the user can pass an explicit session id to look
  // up a specific session from elsewhere.
  const rawSessions = listSessions(
    flags.all
      ? { workspace: process.cwd() }
      : { ccSessionId: cc, workspace: process.cwd() },
    env
  );
  // Reconcile: any entry that still says running may actually be done.
  const sessions = rawSessions.map((s) => reconcileSessionState(s, env));
  if (flags.json) { process.stdout.write(JSON.stringify(sessions, null, 2) + "\n"); return; }

  if (sessions.length === 0) { process.stdout.write("(no sessions)\n"); return; }
  for (const s of sessions) {
    process.stdout.write(`${s.sessionId}  [${s.status}]  ${s.promptSummary}\n`);
  }
}

// ─── cancel ─────────────────────────────────────────────────────────────────
async function cmdCancel(argv) {
  if (maybePrintHelp("cancel", argv)) return;
  const { flags, positionals } = parseArgs(argv, {
    "all":       { type: "boolean" },
    "workspace": { type: "boolean" },
    "json":      { type: "boolean" }
  });
  if (positionals.length > 1) {
    die(`unexpected extra token(s) after session id: ${JSON.stringify(positionals.slice(1).join(" "))} — cancel accepts at most one session id (use --all to cancel multiple)`);
  }

  const env = process.env;
  const cc = ccSessionIdFromEnv();

  if (positionals[0]) {
    const rec = findSession(positionals[0], env);
    if (!rec) die(`no session "${positionals[0]}"`);
    cancelSession(rec, env);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ cancelled: [rec.sessionId] }, null, 2) + "\n");
    } else {
      process.stdout.write(`cancelled ${rec.sessionId}\n`);
    }
    return;
  }

  if (flags.all) {
    const all = listSessions(
      flags.workspace
        ? { workspace: process.cwd(), statuses: ["running", "queued"] }
        : { ccSessionId: cc, workspace: process.cwd(), statuses: ["running", "queued"] },
      env
    );
    for (const rec of all) cancelSession(rec, env);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ cancelled: all.map((r) => r.sessionId) }, null, 2) + "\n");
    } else {
      process.stdout.write(`cancelled ${all.length} session(s)\n`);
    }
    return;
  }

  die("missing session id — usage: /oc:cancel <session-id> | --all [--workspace]");
}

// ─── gc (called by hook) ────────────────────────────────────────────────────
async function cmdGc(argv) {
  const { flags } = parseArgs(argv, {
    "session-id": { type: "string" },
    "json":       { type: "boolean" }
  });
  const env = process.env;
  const ccSession = flags["session-id"] || ccSessionIdFromEnv();
  // Reconcile candidates BEFORE marking them detached. `detached` is terminal
  // (see TERMINAL_STATUSES in lib/spawn.mjs), so blindly flipping every
  // `running`/`queued` row to `detached` would freeze a job whose log already
  // shows `session_idle` / `step_finish` (a normally-completed run whose
  // in-process reconcile happened to miss it) into the wrong final status —
  // future /oc:tail calls would no longer transition it to `completed`. The
  // reconcile pass is done OUTSIDE the lock below because
  // reconcileSessionState takes the ledger lock internally per update;
  // nesting would deadlock. The CC session is ending, so no concurrent
  // /oc:spawn from this session can introduce new records in the window
  // between reconcile and detach-mark.
  if (ccSession) {
    const idx0 = loadIndex(env);
    const candidates = idx0.sessions.filter(
      (s) => s.ccSessionId === ccSession && (s.status === "running" || s.status === "queued")
    );
    for (const c of candidates) {
      try {
        let rec = c;
        if (rec.pending) {
          const resolved = resolvePendingSession(rec, env);
          if (resolved) rec = findSession(resolved, env) ?? rec;
        }
        reconcileSessionState(rec, env);
      } catch {
        // Best effort — if reconcile fails, the detach pass below will still
        // catch this entry. We just won't have transitioned it to completed.
      }
    }
  }

  // Ledger mutation is wrapped in the ledger lock so that a concurrent
  // /oc:spawn from a freshly-started next CC session can't race the
  // detach-mark + save.
  const detached = withLedgerLock(env, () => {
    const idx = loadIndex(env);
    let n = 0;
    for (const s of idx.sessions) {
      if (ccSession && s.ccSessionId === ccSession && (s.status === "running" || s.status === "queued")) {
        s.status = "detached";
        s.updatedAt = new Date().toISOString();
        n++;
      }
    }
    saveIndex(idx, env);
    return n;
  });
  // Prune old logs: by age first, then by total size cap.
  // Also prune old per-spawn run dirs (created by builder.mjs). These are
  // filesystem-only operations, not ledger writes — no lock needed.
  const { config } = loadUserConfig({ env });
  const days = config.retention?.logsDays ?? 14;
  const maxBytes = (config.retention?.maxLogsMb ?? 500) * 1024 * 1024;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let pruned = 0;
  const runsRoot = path.join(pluginDataRoot(env), "runs");
  if (fs.existsSync(runsRoot)) {
    for (const d of fs.readdirSync(runsRoot)) {
      const dp = path.join(runsRoot, d);
      try {
        const st = fs.statSync(dp);
        if (st.mtimeMs < cutoff) { fs.rmSync(dp, { recursive: true, force: true }); pruned++; }
      } catch { /* skip */ }
    }
  }
  const logsRoot = path.join(pluginDataRoot(env), "logs");
  if (fs.existsSync(logsRoot)) {
    // Pass 1: age-based prune.
    const surviving = [];
    for (const f of fs.readdirSync(logsRoot)) {
      const fp = path.join(logsRoot, f);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) { fs.unlinkSync(fp); pruned++; }
        else surviving.push({ fp, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* skip */ }
    }
    // Pass 2: size cap. Sort by mtime ascending (oldest first), drop until under cap.
    surviving.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = surviving.reduce((s, x) => s + x.size, 0);
    while (total > maxBytes && surviving.length > 0) {
      const drop = surviving.shift();
      try { fs.unlinkSync(drop.fp); pruned++; total -= drop.size; } catch { /* skip */ }
    }
  }
  if (flags.json) process.stdout.write(JSON.stringify({ detached, pruned }, null, 2) + "\n");
}

// ─── models (diagnostic — used to suggest alternatives after a spawn failure) ─
// Reads opencode's own registry; never gates spawns. Unions the opencode-
// managed cache with user-defined custom providers, matching omoctl's reader.
// Shared token-similarity scoring used by `models` and `agents` diagnostics.
// Splits on `-_/\s.` so e.g. "deepseek-v4-flash" → ["deepseek","v4","flash"] and
// "build_agent" → ["build","agent"]. Each hint token contributes 1.0 for an
// exact token match, 0.5 for a substring overlap — but ONLY when both the hint
// token and the candidate token are ≥ 2 chars. Without the hint-length guard,
// a one-letter hint like `a` would score 0.5 against every candidate containing
// the letter, drowning real matches in noise.
function tokensOf(s) {
  return String(s).toLowerCase().split(/[-_/\s.]+/).filter(Boolean);
}
function scoreOf(hintTokens, candidate) {
  const ct = tokensOf(candidate);
  let s = 0;
  for (const h of hintTokens) {
    if (ct.includes(h)) s += 1.0;
    else if (h.length >= 2 && ct.some((t) => t.length >= 2 && (t.includes(h) || h.includes(t)))) s += 0.5;
  }
  return s;
}

async function cmdModels(argv) {
  if (maybePrintHelp("models", argv)) return;
  const { flags, positionals, rest } = parseArgs(argv, {
    "provider": { type: "string" },
    "match":    { type: "string" },
    "json":     { type: "boolean" }
  });
  // Reject stray tokens. A multi-word hint must be quoted (`models --match
  // "deep seek"`); without this guard, the second and later words become
  // positionals and are silently dropped.
  const stray = [...positionals, ...rest];
  if (stray.length) {
    die(`unexpected token(s): ${JSON.stringify(stray.join(" "))} — pass multi-word values in quotes: models --match "<hint>"`);
  }
  // Reject empty-string AND whitespace-only values. `--match=` or
  // `--match "   "` would otherwise fall through to the bare-list path
  // (truthy check via the existing `flags.match ? …` later), silently
  // doing nothing the caller asked for. Same for `--provider=`.
  for (const f of ["provider", "match"]) {
    if (flags[f] !== undefined && (typeof flags[f] !== "string" || flags[f].trim() === "")) {
      die(`--${f} value must be a non-empty string`);
    }
  }

  const env = process.env;
  const cachePath = path.join(env.HOME || "", ".cache", "opencode", "models.json");
  const customPath = path.join(env.HOME || "", ".config", "opencode", "opencode.json");

  function safeReadJson(p) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) {
      if (e.code === "ENOENT") return null;
      if (e.name === "SyntaxError") {
        process.stderr.write(`oc: warning: ${p} is not valid JSON (${e.message}); skipping\n`);
        return null;
      }
      throw e;
    }
  }

  const cache = safeReadJson(cachePath);
  const custom = safeReadJson(customPath);
  const customProviders = (custom && typeof custom === "object" && custom.provider) || {};

  const providers = new Map();
  function ensure(name) { if (!providers.has(name)) providers.set(name, new Set()); return providers.get(name); }
  function ingest(name, modelsObj) {
    const set = ensure(name);
    if (modelsObj && typeof modelsObj === "object" && !Array.isArray(modelsObj)) {
      for (const id of Object.keys(modelsObj)) set.add(id);
    }
  }
  if (cache && typeof cache === "object") {
    for (const [name, p] of Object.entries(cache)) {
      if (p && typeof p === "object") ingest(name, p.models);
      else ensure(name);
    }
  }
  for (const [name, p] of Object.entries(customProviders)) {
    if (p && typeof p === "object") ingest(name, p.models);
    else ensure(name);
  }

  if (providers.size === 0) {
    const msg = `no model registry found. Looked in:\n  ${cachePath}\n  ${customPath}\nRun \`opencode\` once to populate the cache.`;
    if (flags.json) {
      process.stdout.write(JSON.stringify({ providers: [], error: msg }, null, 2) + "\n");
      process.exit(1);
    }
    die(msg);
  }

  const hintTokens = flags.match ? tokensOf(flags.match) : null;

  if (flags.provider) {
    const prov = flags.provider;
    if (!providers.has(prov)) {
      const all = [...providers.keys()].sort();
      // Score against the typed-but-unknown provider name (typo fix), and also
      // against --match if given (catches "wrong provider with right model hint").
      const provTokens = tokensOf(prov);
      const suggestion = all
        .map((p) => {
          const nameScore = scoreOf(provTokens, p);
          const modelScore = hintTokens
            ? Math.max(0, ...[...providers.get(p)].map((id) => scoreOf(hintTokens, id)))
            : 0;
          return [p, nameScore * 2 + modelScore];
        })
        .filter(([, s]) => s > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([p]) => p)
        .slice(0, 5);
      if (flags.json) {
        process.stdout.write(JSON.stringify({ error: `unknown provider "${prov}"`, providers: all, closest: suggestion }, null, 2) + "\n");
        process.exit(1);
      }
      const tail = suggestion.length ? `\nClosest match: ${suggestion.join(", ")}` : "";
      die(`unknown provider "${prov}". Available:\n  ${all.join("\n  ")}${tail}`);
    }
    const ids = [...providers.get(prov)].sort();
    let ranked = ids;
    if (hintTokens) {
      const scored = ids
        .map((id) => ({ id, score: scoreOf(hintTokens, id) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.id.length - b.id.length);
      if (scored.length > 0) ranked = scored.map((r) => r.id);
    }
    if (flags.json) {
      process.stdout.write(JSON.stringify({ provider: prov, models: ranked }, null, 2) + "\n");
      return;
    }
    for (const id of ranked) process.stdout.write(`${prov}/${id}\n`);
    return;
  }

  if (hintTokens) {
    const all = [];
    for (const [name, set] of providers) {
      for (const id of set) {
        const combined = `${name}/${id}`;
        all.push({ providerModel: combined, score: scoreOf(hintTokens, combined) });
      }
    }
    const ranked = all
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.providerModel.length - b.providerModel.length)
      .slice(0, 20);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ match: flags.match, candidates: ranked.map((r) => r.providerModel) }, null, 2) + "\n");
      return;
    }
    if (ranked.length === 0) die(`no models match "${flags.match}"`);
    for (const r of ranked) process.stdout.write(`${r.providerModel}\n`);
    return;
  }

  const out = [...providers.entries()]
    .map(([name, set]) => ({ provider: name, model_count: set.size }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
  if (flags.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }
  for (const r of out) process.stdout.write(`${r.provider.padEnd(28)} ${r.model_count}\n`);
}

// ─── agents ─────────────────────────────────────────────────────────────────
// Diagnostic. Lists opencode-resolved agents (built-ins + global config +
// project config + plugin packages, all merged by opencode). We don't re-read
// any of those sources ourselves — opencode owns agent resolution, we just
// shell out to `opencode agent list` and re-emit the names + kinds in a shape
// Claude can scan cheaply (no per-agent permission JSON noise). Called by
// Claude in the same two situations as `models`: BEFORE spawning when the
// user wrote the agent name with whitespace (natural-language hint), and
// AFTER spawning when opencode rejected an unknown agent (typo recovery).
async function cmdAgents(argv) {
  if (maybePrintHelp("agents", argv)) return;
  const { flags, positionals, rest } = parseArgs(argv, {
    "match": { type: "string" },
    "json":  { type: "boolean" }
  });
  // Reject stray tokens. A multi-word hint must be quoted (`agents --match
  // "build agent"`); without this guard, the second and later words get
  // silently dropped as positionals.
  const stray = [...positionals, ...rest];
  if (stray.length) {
    die(`unexpected token(s): ${JSON.stringify(stray.join(" "))} — pass multi-word hints in quotes: agents --match "<hint>"`);
  }
  // Reject `--match=` (empty) AND `--match "   "` (whitespace-only).
  // Fallthrough would silently behave like bare `agents`, hiding the
  // user's filter intent.
  if (flags.match !== undefined && (typeof flags.match !== "string" || flags.match.trim() === "")) {
    die("--match value must be a non-empty string");
  }

  const env = process.env;
  const bin = findOpencodeBinary({ env });
  if (!bin) die("opencode binary not found on PATH. Install it (`curl -fsSL https://opencode.ai/install | bash`) and rerun.");

  const r = spawnSync(bin, ["agent", "list"], { env, encoding: "utf8", timeout: 10000 });
  if (r.error) {
    // spawnSync itself failed (e.g. ETIMEDOUT, EAGAIN, max-buffer exceeded).
    // r.status is null in this case; surface the error code/message so the
    // caller has something to act on instead of an empty "exit null" line.
    die(`opencode agent list could not run: ${r.error.code || r.error.message || String(r.error)}`);
  }
  if (r.status !== 0) {
    const stderr = (r.stderr || "").trim();
    die(`opencode agent list failed (exit ${r.status})${stderr ? `: ${stderr}` : ""}`);
  }

  // `opencode agent list` emits, per agent, a header line `<name> (kind)` at
  // column 1 followed by an indented JSON permission block. Headers are the
  // only column-1 lines, which is all we need. Names may contain dots
  // (provider-style ids) plus alphanumerics, `_`, and `-`.
  const HEADER = /^([A-Za-z0-9._-]+)\s+\((primary|subagent)\)\s*$/;
  const agents = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.match(HEADER);
    if (m) agents.push({ name: m[1], kind: m[2] });
  }

  if (agents.length === 0) {
    const msg = "no agents parsed from `opencode agent list` output. Run the command directly to inspect.";
    if (flags.json) {
      process.stdout.write(JSON.stringify({ agents: [], error: msg }, null, 2) + "\n");
      process.exit(1);
    }
    die(msg);
  }

  let ranked = agents;
  if (flags.match) {
    const hintTokens = tokensOf(flags.match);
    const scored = agents
      .map((a) => ({ ...a, score: scoreOf(hintTokens, a.name) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.name.length - b.name.length);
    if (scored.length === 0) {
      const msg = `no agents match "${flags.match}". Available: ${agents.map((a) => a.name).join(", ")}`;
      if (flags.json) {
        process.stdout.write(JSON.stringify({ match: flags.match, candidates: [], all: agents }, null, 2) + "\n");
        process.exit(1);
      }
      die(msg);
    }
    ranked = scored;
  } else {
    ranked = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({ match: flags.match || null, agents: ranked.map(({ name, kind }) => ({ name, kind })) }, null, 2) + "\n");
    return;
  }
  const width = Math.max(...ranked.map((a) => a.name.length));
  for (const a of ranked) process.stdout.write(`${a.name.padEnd(width)}  ${a.kind}\n`);
}

// Read the prompt body from stdin. Returns null when stdin is a TTY (no
// pipe attached), otherwise the buffer verbatim — newlines, $, backticks,
// quotes all pass through unchanged. Only used by `spawn`, which always
// expects a prompt; other subcommands ignore stdin entirely.
async function readPromptFromStdin() {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(`oc <subcommand> [args]\n\nSubcommands:\n  spawn     start an OpenCode session (always detached; /oc:tail to wait)\n  tail      stream/peek a session's progress\n  sessions  list/inspect spawned sessions\n  cancel    cancel one or all running sessions\n  models    list providers/models (diagnostic; suggests alternatives after a failed spawn)\n  agents    list opencode-resolved agents (diagnostic; suggests alternatives after a failed spawn)\n`);
    return;
  }
  if (!SUBCMDS.has(sub)) die(`unknown subcommand: ${sub}`);
  const rest = argv.slice(1);

  // Single transport convention: argv carries flags only; the spawn prompt
  // body arrives on stdin. tail/sessions/cancel/gc/models take no prompt and
  // ignore stdin. No `--` separator, no `--stdin` / `--prompt-stdin` flags.
  try {
    if (sub === "spawn") {
      // `spawn --help` must print help without first consuming stdin —
      // otherwise a piped-but-help invocation (e.g. `spawn --help < /dev/null`
      // or a heredoc) would block reading the body before help can fire.
      const wantsHelp = rest.some((t) => t === "--help" || t === "-h");
      const prompt = wantsHelp ? null : await readPromptFromStdin();
      await cmdSpawn(rest, prompt);
    }
    else if (sub === "tail")    await cmdTail(rest);
    else if (sub === "sessions") await cmdSessions(rest);
    else if (sub === "cancel")  await cmdCancel(rest);
    else if (sub === "gc")      await cmdGc(rest);
    else if (sub === "models")  await cmdModels(rest);
    else if (sub === "agents")  await cmdAgents(rest);
  } catch (e) {
    die(e.message || String(e));
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
