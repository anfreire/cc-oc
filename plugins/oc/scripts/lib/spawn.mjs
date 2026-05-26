// Start `opencode run --format json ...` and return immediately.
//
// One mode: detached + fire-and-forget.
//   - Opencode is spawned with `detached: true` (POSIX setsid()), giving it
//     its own session/process group so group-targeted signals hitting cc-oc
//     do not reach the child.
//   - Stdio is wired to the per-spawn log file via raw file descriptors, not
//     pipes — cc-oc's death does not break opencode's output channel.
//   - cc-oc awaits only the child's `spawn` (success) or `error` (ENOENT/EPERM
//     /etc.) event — long enough to detect a stillborn spawn, not long enough
//     to wait for opencode to finish — then `child.unref()`s and resolves.
//     The bash call that invoked `oc.mjs spawn` finishes in milliseconds;
//     opencode keeps running, writing its NDJSON events to the log file,
//     until it exits on its own.
//
// To wait for opencode to finish, the caller runs `/oc:tail <id> --follow`,
// which blocks on the log file's terminal event (`step_finish` /
// `session_idle`) and exits. To peek at current progress, `/oc:tail <id>`.
// To abort, `/oc:cancel <id>`.
//
// Ledger lifecycle:
//   - On successful spawn, an entry is upserted with status="running",
//     pending=true, the pending id, the log file path, and the child's pid.
//   - On a spawn-time failure (ENOENT/EPERM/etc.), a SpawnError event is
//     appended to the log so reconcileSessionState marks the entry "failed"
//     the next time /oc:tail or /oc:sessions runs.
//   - The entry transitions to completed/failed lazily — when /oc:tail,
//     /oc:sessions, or the SessionEnd `gc` hook scans the log for terminal
//     events. cc-oc itself does NOT block to observe that transition.
//
// Note: `detached: true` has different semantics on Windows (separates the
// console rather than the process group); cc-oc targets POSIX (Linux/macOS)
// because opencode does, but the signal-isolation guarantee above is
// specifically a POSIX property.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { shortPrompt } from "./render.mjs";
import {
  logFileFor,
  logsDir,
  upsertSession,
  loadIndex,
  saveIndex,
  withLedgerLock
} from "./ledger.mjs";

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Statuses that mean "done, do not mutate further." Once a record reaches one
// of these, reconcileSessionState must leave its status alone — even if the
// log later shows a terminal event from work that completed before/during the
// cancel. Without this guard, a step_finish landing right after SIGTERM could
// flip "cancelled" back to "completed."
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "detached"]);

function isActiveRecord(record) {
  if (TERMINAL_STATUSES.has(record.status)) return false;
  return record.status === "running" || record.status === "queued" || record.pending === true;
}

function buildCliArgs({ model, variant, agent, cwd, sandbox, continueId, pure }) {
  const args = ["run", "--format", "json"];
  if (sandbox === "workspace-write") args.push("--dangerously-skip-permissions");
  if (cwd) { args.push("--dir", cwd); }
  if (model) { args.push("--model", model); }
  if (variant) { args.push("--variant", variant); }
  if (agent) { args.push("--agent", agent); }
  if (continueId) { args.push("--session", continueId); }
  if (pure) { args.push("--pure"); }
  return args;
}

function buildSpawnEnv({ configDir, env = process.env, disableProjectConfig }) {
  // The spawned opencode inherits the caller's environment by default — same
  // posture as launching `opencode` directly. We only override two keys that
  // opencode reads from the env to control config loading.
  const out = { ...env };
  // OPENCODE_CONFIG_DIR is authoritative for this spawn: when the builder
  // produced an override dir, point opencode at it; when there's nothing to
  // override, clear an inherited value so opencode runs against its own
  // discovery path and not some stale dir from the parent shell.
  if (configDir) out.OPENCODE_CONFIG_DIR = configDir;
  else delete out.OPENCODE_CONFIG_DIR;
  // disableProjectConfig is authoritative too: explicit false (default, or
  // --project on the CLI) must override an inherited disable from the parent
  // env, otherwise the positive flag is silently a no-op.
  if (disableProjectConfig) out.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  else delete out.OPENCODE_DISABLE_PROJECT_CONFIG;
  return out;
}

// Parse one NDJSON line. Returns the event or null.
function parseLine(line) {
  const s = line.trim();
  if (s === "") return null;
  try { return JSON.parse(s); } catch { return null; }
}

function extractSessionId(event) {
  if (!event) return null;
  if (typeof event.sessionID === "string") return event.sessionID;
  if (typeof event.sessionId === "string") return event.sessionId;
  if (event.part && typeof event.part.sessionID === "string") return event.part.sessionID;
  return null;
}

function extractText(event) {
  if (!event) return null;
  if (event.type === "text" && typeof event.text === "string") return event.text;
  if (event.part && event.part.type === "text" && typeof event.part.text === "string") return event.part.text;
  return null;
}

/**
 * Start opencode detached and return as soon as the child is exec'd.
 *
 * Awaits only the child's `spawn` (success) or `error` (ENOENT/EPERM/etc.)
 * event. On success, upserts the ledger entry and `child.unref()`s; on
 * failure, appends a SpawnError event to the pending log so the reconciler
 * will mark the entry "failed" on the next /oc:tail or /oc:sessions call.
 *
 * Resolves with: { pid, pendingId, pendingLog, configDir, spawnError? }
 */
export async function startSpawn({
  binary,
  prompt,
  configDir = null,
  model,
  variant,
  agent,
  cwd,
  sandbox = "read-only",
  continueId = null,
  pure = false,
  ccSessionId = null,
  env = process.env,
  disableProjectConfig = false
}) {
  const args = buildCliArgs({ model, variant, agent, cwd, sandbox, continueId, pure });
  args.push("--", prompt);
  const spawnEnv = buildSpawnEnv({ configDir, env, disableProjectConfig });
  try {
    fs.mkdirSync(logsDir(env), { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(`cannot create logs dir at ${logsDir(env)} (${e.code || e.message}). Check filesystem permissions.`);
  }

  // Pending log — once we observe a sessionId in the events, /oc:tail can rename it.
  const pendingId = `_pending_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const pendingLog = path.join(logsDir(env), `${pendingId}.ndjson`);
  let out = null, err = null;
  try {
    out = fs.openSync(pendingLog, "a", 0o600);
    err = fs.openSync(pendingLog, "a", 0o600);
  } catch (e) {
    // If the first openSync succeeded and the second threw, close the
    // first to avoid leaking the fd as we rethrow.
    if (out !== null) { try { fs.closeSync(out); } catch { /* ignore */ } }
    throw new Error(`cannot open log file at ${pendingLog} (${e.code || e.message}). Check filesystem permissions.`);
  }

  // `detached: true` calls setsid() on POSIX so the child gets a brand-new
  // session and process group. That isolates it from process-group-targeted
  // signals (terminal SIGINT, `kill -TERM -<pgid>`) — only the parent gets
  // those, and the child genuinely survives the kill. The child's stdio uses
  // raw file descriptors, not pipes through us, so cc-oc's exit does not
  // break the log-write channel either.
  //
  // `spawn()` can throw synchronously on invalid options (TypeError-class
  // errors). The try/finally below closes our copies of the log fds even on
  // that path — without it, a sync throw would leak both descriptors.
  let child;
  try {
    child = spawn(binary, args, {
      env: spawnEnv,
      cwd: cwd || process.cwd(),
      stdio: ["ignore", out, err],
      detached: true
    });
  } finally {
    // Parent no longer needs its copy of the log fds — on the success path
    // the child has dup'd them and will write through its own copies; on the
    // sync-throw path the child never existed and our fds are the only
    // references.
    try { fs.closeSync(out); } catch { /* ignore — keep any original error */ }
    try { fs.closeSync(err); } catch { /* ignore */ }
  }

  // Wait for one of: "spawn" (success — child has exec'd) or "error"
  // (ENOENT/EPERM/etc. — child failed to exec). Anything past that point is
  // opencode's own runtime, which we do not wait for — the caller pulls the
  // final result via /oc:tail <id> --follow when (if) they want to block.
  const spawnOutcome = await new Promise((resolve) => {
    let settled = false;
    child.once("spawn", () => {
      if (!settled) { settled = true; resolve({ ok: true }); }
    });
    child.once("error", (e) => {
      if (!settled) { settled = true; resolve({ ok: false, error: e }); }
    });
  });

  if (!spawnOutcome.ok) {
    // ENOENT/EPERM/etc.: append a SpawnError event to the pending log so
    // reconcileSessionState will mark the eventual ledger entry "failed"
    // the next time /oc:tail or /oc:sessions runs. No ledger upsert here —
    // we never had a real session; the caller will report the failure.
    try {
      fs.appendFileSync(pendingLog, JSON.stringify({
        type: "error",
        timestamp: Date.now(),
        error: { name: "SpawnError", data: { message: `cc-oc could not start opencode: ${spawnOutcome.error.code || spawnOutcome.error.message}` } }
      }) + "\n");
    } catch { /* ignore — best effort */ }
    return { pid: child.pid, pendingId, pendingLog, configDir, spawnError: spawnOutcome.error };
  }

  // Provisional ledger entry — sessionId unknown yet, recorded under the
  // pending key. The reconciler migrates this entry to the real opencode
  // session id when /oc:tail / /oc:sessions scans the log and finds the
  // first event with a sessionID.
  upsertSession({
    sessionId: pendingId,
    ccSessionId,
    workspace: cwd || process.cwd(),
    status: "running",
    model: model ?? null,
    agent: agent ?? null,
    sandbox,
    configDir: configDir ?? null,
    logFile: pendingLog,
    pid: child.pid,
    prompt,
    promptSummary: shortPrompt(prompt),
    startedAt: new Date().toISOString(),
    pending: true
  }, env);

  // Release the child so cc-oc's event loop can exit. The child is now a
  // self-contained process: separate session/pgrp, file-fd stdio, no
  // dangling references in this Node process.
  child.unref();

  return { pid: child.pid, pendingId, pendingLog, configDir };
}

// Helper used by tail and sessions: if an index entry is still `pending` (no
// real OpenCode sessionID yet), peek at its log for the first sessionID we see
// and rewrite the index entry in place. The log FILE stays where it is — we
// only update the entry's sessionId + pending flag.
export function resolvePendingSession(record, env = process.env) {
  if (!record.pending) return record.sessionId;
  if (!record.logFile || !fs.existsSync(record.logFile)) return null;
  let content;
  try { content = fs.readFileSync(record.logFile, "utf8"); } catch { return null; }
  let sid = null;
  for (const line of content.split("\n")) {
    const ev = parseLine(line);
    if (!ev) continue;
    sid = extractSessionId(ev);
    if (sid) break;
  }
  if (!sid) return null;
  withLedgerLock(env, () => {
    const idx = loadIndex(env);
    const filtered = idx.sessions.filter((s) => s.sessionId !== record.sessionId);
    // Preserve the original pending id on the migrated entry so findSession()
    // still resolves it. Otherwise the `<pendingId>` printed in the
    // started-session block (and quoted in recovery commands) goes stale on
    // the first /oc:tail or /oc:sessions call.
    filtered.push({
      ...record,
      sessionId: sid,
      pendingId: record.sessionId,
      pending: false,
      updatedAt: new Date().toISOString()
    });
    idx.sessions = filtered;
    saveIndex(idx, env);
  });
  return sid;
}

// Scan a session's log file. If we see a terminal event after the entry's
// startedAt, mark the record completed/failed. If the entry has a tracked PID
// that is no longer alive AND the log shows no terminal event, mark failed
// (crashed silently). Returns the (possibly updated) record.
export function reconcileSessionState(record, env = process.env) {
  if (!record || !record.logFile) return record;
  if (!fs.existsSync(record.logFile)) {
    // Entry whose log was never created — check PID liveness.
    if (record.pid && isActiveRecord(record)) {
      if (!isPidAlive(record.pid)) {
        return withLedgerLock(env, () => {
          const idx = loadIndex(env);
          const filtered = idx.sessions.filter((s) => s.sessionId !== record.sessionId);
          const updated = {
            ...record,
            status: "failed",
            errorMessage: "opencode child exited before producing any events",
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          filtered.push(updated);
          idx.sessions = filtered;
          saveIndex(idx, env);
          return updated;
        });
      }
    }
    return record;
  }

  let content;
  try { content = fs.readFileSync(record.logFile, "utf8"); } catch { return record; }
  // Only consider events that landed at or after this entry's start — guards
  // against resumed sessions reusing a log and confusing the reconciler.
  const startedAtMs = record.startedAt ? Date.parse(record.startedAt) : 0;
  let lastText = null;
  let terminalType = null;
  let observedSid = record.sessionId;
  for (const line of content.split("\n")) {
    const ev = parseLine(line);
    if (!ev) continue;
    if (typeof ev.timestamp === "number" && ev.timestamp < startedAtMs) continue;
    const sid = extractSessionId(ev);
    if (sid) observedSid = sid;
    const text = extractText(ev);
    if (text) lastText = text;
    const t = ev.type;
    const partType = ev.part?.type;
    if (t === "session_idle" || t === "session.idle") terminalType = "completed";
    else if (t === "session_error" || t === "session.error" || t === "error") terminalType = "failed";
    else if (t === "step_finish" || partType === "step-finish") terminalType = terminalType ?? "completed";
  }

  const active = isActiveRecord(record);

  // No terminal event yet, but the tracked child is dead → mark failed (crashed).
  if (active && !terminalType && record.pid && !isPidAlive(record.pid)) {
    terminalType = "failed";
  }

  if (terminalType && active) {
    return withLedgerLock(env, () => {
      const idx = loadIndex(env);
      const filtered = idx.sessions.filter((s) => s.sessionId !== record.sessionId);
      const updated = {
        ...record,
        sessionId: observedSid,
        pending: false,
        status: terminalType,
        completedAt: new Date().toISOString(),
        lastAssistantText: lastText ?? record.lastAssistantText ?? null,
        updatedAt: new Date().toISOString()
      };
      filtered.push(updated);
      idx.sessions = filtered;
      saveIndex(idx, env);
      return updated;
    });
  }
  if (observedSid && observedSid !== record.sessionId) {
    // Pending entry but no terminal yet — at least migrate the sessionId.
    return withLedgerLock(env, () => {
      const idx = loadIndex(env);
      const filtered = idx.sessions.filter((s) => s.sessionId !== record.sessionId);
      const updated = { ...record, sessionId: observedSid, pending: false, updatedAt: new Date().toISOString() };
      filtered.push(updated);
      idx.sessions = filtered;
      saveIndex(idx, env);
      return updated;
    });
  }
  return record;
}
