#!/usr/bin/env node
// Main dispatcher for the oc plugin. Subcommands: spawn | tail | sessions | cancel | gc

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { parseArgs, splitCsv, splitRawArgumentString } from "./lib/args.mjs";
import { loadUserConfig, validateConfig } from "./lib/config.mjs";
import { buildConfigDir } from "./lib/builder.mjs";
import { runForeground, runBackground, resolvePendingSession, reconcileSessionState } from "./lib/spawn.mjs";
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

const SUBCMDS = new Set(["spawn", "tail", "sessions", "cancel", "gc", "models"]);
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
    try { process.kill(rec.pid, "SIGTERM"); } catch { /* may already be dead */ }
  }
  // pending: false matters here — without it, a bg entry's pending=true would
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
  spawn: `/oc:spawn [flags] -- <prompt>

Flags:
  --read-only         Default sandbox; opencode's own permission gating applies
  --write             Pass --dangerously-skip-permissions to opencode
  --bg                Detach and return immediately
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
  --reasoning         Stream thinking lines (foreground only)
  --json              Machine-readable result

Recovery:
  cc-oc does not preflight model/provider strings — opencode validates them.
  If opencode rejects a model or provider, run \`oc.mjs models --match <hint>\`
  (optionally with \`--provider <name>\`) to list candidate provider/model ids.
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

Use this AFTER a spawn fails on an unknown model/provider — not before.

  (no flags)            list providers and model counts
  --provider <name>     list models for that provider
  --match <hint>        rank candidates by token match (across all providers,
                        or within --provider when both are given)
  --json                machine-readable output
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
async function cmdSpawn(argv) {
  if (maybePrintHelp("spawn", argv)) return;
  const { flags, positionals, rest } = parseArgs(argv, {
    "read-only": { type: "boolean" },
    "write":     { type: "boolean" },
    "bg":        { type: "boolean" },
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
    "json":      { type: "boolean" },
    "reasoning": { type: "boolean" }
  });

  // --provider and --model: must be specified together, combined into provider/model.
  if (flags.provider && !flags.model) die("--provider requires --model");
  if (flags.model && !flags.provider) die("--model requires --provider");
  if (flags.provider && flags.model) {
    flags.model = `${flags.provider}/${flags.model}`;
  }

  const promptParts = [...positionals, ...rest];
  const prompt = promptParts.join(" ").trim();
  if (prompt === "") die("missing prompt — usage: /oc:spawn [flags] -- <prompt>");

  if (flags.bg && flags.reasoning) {
    process.stderr.write("oc: --reasoning has no effect with --bg; pass it to /oc:tail instead.\n");
  }

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

  const common = {
    binary: bin,
    prompt,
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
  };

  if (flags.bg) {
    const r = await runBackground(common);
    const out = {
      jobClass: "bg",
      pid: r.pid,
      pendingId: r.pendingId,
      pendingLog: r.pendingLog,
      configDir: r.configDir,
      hint: "Use /oc:tail to follow progress; /oc:sessions to list."
    };
    if (flags.json) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    else {
      process.stdout.write(`Started background OpenCode job (pid ${r.pid}).\n`);
      process.stdout.write(`Tail with: /oc:tail\n`);
    }
    return;
  }

  // For --json, suppress streaming digest — emit only the final JSON envelope.
  const fgOpts = { ...common, jobClass: "fg", reasoning: Boolean(flags.reasoning) };
  if (flags.json) fgOpts.onDigest = () => { /* drop */ };

  const r = await runForeground(fgOpts);
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      sessionId: r.sessionId,
      exitCode: r.exitCode,
      lastAssistantText: r.lastAssistantText,
      logFile: r.logFile,
      configDir: r.configDir
    }, null, 2) + "\n");
  } else if (r.lastAssistantText) {
    process.stdout.write(`\n${r.lastAssistantText}\n`);
  }
  process.exit(r.exitCode || 0);
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

  // If background and still pending (no sessionId observed yet), try to migrate.
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
    if (DONE_STATUSES.has(record.status)) {
      const { digest } = readDigest(logFile, { lines: null, since: null, reasoning: Boolean(flags.reasoning) });
      process.stdout.write(digest);
      if (digest && !digest.endsWith("\n")) process.stdout.write("\n");
      return;
    }
    const result = await followLog(logFile, { reasoning: Boolean(flags.reasoning) });
    if (result.timedOut) die(`tail timed out after 15 min`);
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

  const env = process.env;
  const cc = ccSessionIdFromEnv();

  if (positionals[0]) {
    const rec = findSession(positionals[0], env);
    if (!rec) die(`no session "${positionals[0]}"`);
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
  // Reconcile: any background-spawned entry that still says running may actually be done.
  const sessions = rawSessions.map((s) => reconcileSessionState(s, env));
  if (flags.json) { process.stdout.write(JSON.stringify(sessions, null, 2) + "\n"); return; }

  if (sessions.length === 0) { process.stdout.write("(no sessions)\n"); return; }
  for (const s of sessions) {
    process.stdout.write(`${s.sessionId}  [${s.jobClass}/${s.status}]  ${s.promptSummary}\n`);
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
async function cmdModels(argv) {
  if (maybePrintHelp("models", argv)) return;
  const { flags } = parseArgs(argv, {
    "provider": { type: "string" },
    "match":    { type: "string" },
    "json":     { type: "boolean" }
  });

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

  function tokensOf(s) {
    return String(s).toLowerCase().split(/[-_/\s.]+/).filter(Boolean);
  }
  function scoreOf(hintTokens, candidate) {
    const ct = tokensOf(candidate);
    let s = 0;
    for (const h of hintTokens) {
      if (ct.includes(h)) s += 1.0;
      else if (ct.some((t) => t.length >= 2 && (t.includes(h) || h.includes(t)))) s += 0.5;
    }
    return s;
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

// Read raw args from stdin (used by slash command wrappers to avoid shell
// interpolation of $ARGUMENTS). Returns the whole buffer.
async function readArgsFromStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

// Split the raw stdin payload at the first `--` token boundary. Everything
// before that is parsed as flags (and tokenized); everything after is taken
// as the prompt VERBATIM. The previous implementation tokenized the whole
// buffer and then re-joined with single spaces, which collapsed runs of
// whitespace and stripped newlines inside the prompt body.
function splitFlagsAndPrompt(raw) {
  const m = raw.match(/(?:^|\s)--(?:\s|$)/);
  if (!m) return { flagsRaw: raw, promptRaw: null };
  return {
    flagsRaw: raw.slice(0, m.index),
    promptRaw: stripPromptShell(raw.slice(m.index + m[0].length))
  };
}

// CC's slash-command harness passes `$ARGUMENTS` to us verbatim, which means
// the user-typed quotes around the prompt arrive literally in the buffer
// (e.g. `-- "review the diff"`). Peel one matching outer-quote pair and the
// trailing newline that shell stdin helpers usually carry. Everything inside
// is left untouched — repeated spaces, embedded quotes, $, backticks, all of
// it passes through.
function stripPromptShell(s) {
  let out = s.replace(/^[ \t]+/, "").replace(/\n+$/, "");
  if (out.length >= 2) {
    const first = out[0], last = out[out.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      out = out.slice(1, -1);
    }
  }
  return out;
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(`oc <subcommand> [args]\n\nSubcommands:\n  spawn     spawn an OpenCode task (foreground; --bg for background)\n  tail      stream/peek a session's progress\n  sessions  list/inspect spawned sessions\n  cancel    cancel one or all running sessions\n  models    list providers/models (diagnostic; suggests alternatives after a failed spawn)\n`);
    return;
  }
  if (!SUBCMDS.has(sub)) die(`unknown subcommand: ${sub}`);
  let rest = argv.slice(1);

  // Two stdin modes:
  //
  //   --stdin        (slash-command pattern): the whole $ARGUMENTS string —
  //                  flags AND prompt together — is sent over stdin so the
  //                  shell never gets a chance to reinterpret it. We split
  //                  on the first ` -- ` separator: flag portion is tokenised,
  //                  prompt portion is preserved verbatim.
  //
  //   --prompt-stdin (programmatic / subagent pattern): flags arrive via argv
  //                  as normal, but the prompt body is piped on stdin (e.g.
  //                  from a heredoc). Useful when a caller cannot safely
  //                  quote the prompt on a single command line.
  if (rest[0] === "--stdin") {
    const buf = await readArgsFromStdin();
    const { flagsRaw, promptRaw } = splitFlagsAndPrompt(buf);
    const tokens = splitRawArgumentString(flagsRaw);
    // spawn takes a prompt body; if the user piped flag-like tokens without an
    // explicit ` -- ` separator, parseArgs would silently consume them as flags
    // (or throw `unknown flag`) and the user's intended prompt would be lost.
    // Fail fast with an actionable message instead. Other subcommands take
    // only flags / a session-id positional, so this rule is spawn-only.
    if (sub === "spawn" && promptRaw === null && tokens.some((t) => /^--?[A-Za-z]/.test(t))) {
      die("missing ` -- ` separator before prompt — flag-like tokens (--xyz / -x) in the prompt would be parsed as flags. Example: /oc:spawn --bg -- \"your prompt\"");
    }
    rest = [...rest.slice(1), ...tokens];
    if (promptRaw !== null) rest.push("--", promptRaw);
  } else if (rest.includes("--prompt-stdin")) {
    const buf = await readArgsFromStdin();
    rest = rest.filter((t) => t !== "--prompt-stdin");
    rest.push("--", buf.replace(/\n+$/, ""));
  }

  try {
    if (sub === "spawn")        await cmdSpawn(rest);
    else if (sub === "tail")    await cmdTail(rest);
    else if (sub === "sessions") await cmdSessions(rest);
    else if (sub === "cancel")  await cmdCancel(rest);
    else if (sub === "gc")      await cmdGc(rest);
    else if (sub === "models")  await cmdModels(rest);
  } catch (e) {
    die(e.message || String(e));
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
