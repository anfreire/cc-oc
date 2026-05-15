// Spawn `opencode run --format json ...` and stream NDJSON events.
//
// Two modes:
//   runForeground({ ... }): pipes events to a digest line writer (default stdout)
//                          AND mirrors raw events to a log file. Blocks until exit.
//   runBackground({ ... }): detaches, redirects stdout to the log file, returns
//                           { pid, sessionId? } immediately. Caller polls index/log.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { renderEvent, shortPrompt } from "./render.mjs";
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

function buildCliArgs({ model, variant, agent, cwd, sandbox, continueId, pure, extra = [] }) {
  const args = ["run", "--format", "json"];
  if (sandbox === "workspace-write") args.push("--dangerously-skip-permissions");
  if (cwd) { args.push("--dir", cwd); }
  if (model) { args.push("--model", model); }
  if (variant) { args.push("--variant", variant); }
  if (agent) { args.push("--agent", agent); }
  if (continueId) { args.push("--session", continueId); }
  if (pure) { args.push("--pure"); }
  for (const e of extra) args.push(e);
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
 * Run opencode in the foreground. Streams digest lines to `onDigest` (default: process.stdout)
 * and writes every event verbatim to the per-session log file.
 *
 * Resolves with: { sessionId, exitCode, lastAssistantText, logFile, configDir }
 */
export async function runForeground({
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
  jobClass = "fg",
  env = process.env,
  disableProjectConfig = false,
  reasoning = false,
  onDigest = null
}) {
  const args = buildCliArgs({ model, variant, agent, cwd, sandbox, continueId, pure });
  args.push("--", prompt);
  const spawnEnv = buildSpawnEnv({ configDir, env, disableProjectConfig });

  try {
    fs.mkdirSync(logsDir(env), { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(`cannot create logs dir at ${logsDir(env)} (${e.code || e.message}). Check filesystem permissions.`);
  }
  let logStream = null;
  let logFile = null;
  let sessionId = null;
  let lastAssistantText = null;

  // We don't know the sessionId until the first event lands; until then buffer to a temp file.
  const tmpLog = path.join(logsDir(env), `_pending_${process.pid}_${Date.now()}.ndjson`);
  try {
    logStream = fs.createWriteStream(tmpLog, { flags: "a", mode: 0o600 });
  } catch (e) {
    throw new Error(`cannot open log file at ${tmpLog} (${e.code || e.message}). Check filesystem permissions.`);
  }
  // Surface async stream failures as clean oc messages instead of unhandled 'error' events.
  logStream.on("error", (e) => {
    process.stderr.write(`oc: log write failed at ${tmpLog} (${e.code || e.message})\n`);
  });

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: spawnEnv,
      cwd: cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === "") continue;

        // Always persist raw event to log.
        logStream.write(line + "\n");

        const event = parseLine(line);
        if (!event) continue;
        if (!sessionId) {
          const sid = extractSessionId(event);
          if (sid) {
            sessionId = sid;
            logFile = logFileFor(sessionId, env);
            // Initial index record.
            upsertSession({
              sessionId,
              ccSessionId,
              workspace: cwd || process.cwd(),
              status: "running",
              jobClass,
              model: model ?? null,
              agent: agent ?? null,
              sandbox,
              configDir: configDir ?? null,
              logFile,
              prompt,
              promptSummary: shortPrompt(prompt),
              startedAt: new Date().toISOString(),
              completedAt: null,
              exitCode: null,
              lastAssistantText: null
            }, env);
          }
        }
        const text = extractText(event);
        if (text) lastAssistantText = text;
        const digest = renderEvent(event, { reasoning });
        if (digest && onDigest) onDigest(digest);
        else if (digest) process.stdout.write(digest + "\n");
      }
    });

    child.stderr.on("data", (d) => process.stderr.write(d));

    child.on("error", (err) => {
      logStream.end();
      reject(err);
    });

    child.on("close", (code) => {
      // Flush remaining buffered data, then close.
      if (buf.trim() !== "") {
        logStream.write(buf + "\n");
        const event = parseLine(buf);
        if (event) {
          const text = extractText(event);
          if (text) lastAssistantText = text;
        }
      }
      logStream.end(() => {
        if (sessionId) {
          // Move the pending log to the per-session file (append if it already exists).
          const finalLog = logFileFor(sessionId, env);
          try {
            if (fs.existsSync(finalLog)) {
              fs.appendFileSync(finalLog, fs.readFileSync(tmpLog));
              fs.unlinkSync(tmpLog);
            } else {
              fs.renameSync(tmpLog, finalLog);
            }
          } catch {/* ignore */}
        } else {
          try { fs.unlinkSync(tmpLog); } catch {/* ignore */}
        }
        if (sessionId) {
          upsertSession({
            sessionId,
            status: code === 0 ? "completed" : "failed",
            completedAt: new Date().toISOString(),
            exitCode: code,
            lastAssistantText
          }, env);
        }
        resolve({ sessionId, exitCode: code, lastAssistantText, logFile: sessionId ? logFileFor(sessionId, env) : null, configDir });
      });
    });
  });
}

/**
 * Run opencode in the background. Detaches the child, sends its stdout/stderr to
 * a pending log, and returns immediately. A small monitor process is NOT spawned —
 * /oc:tail and /oc:sessions read the log file directly and update the index when
 * they see new events. We DO write an initial pending index record so the user
 * can locate the job before the first event arrives.
 *
 * Resolves with: { pid, pendingLog, tempIndexId }
 */
export async function runBackground({
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
  let out, err;
  try {
    out = fs.openSync(pendingLog, "a", 0o600);
    err = fs.openSync(pendingLog, "a", 0o600);
  } catch (e) {
    throw new Error(`cannot open log file at ${pendingLog} (${e.code || e.message}). Check filesystem permissions.`);
  }

  const child = spawn(binary, args, {
    env: spawnEnv,
    cwd: cwd || process.cwd(),
    stdio: ["ignore", out, err],
    detached: true
  });
  // Best-effort: surface immediate spawn errors (e.g. ENOENT for a deleted
  // binary, EPERM for a non-executable target) into the pending log so
  // /oc:tail and the reconciler will mark the job failed rather than leaving
  // it stuck in "running" forever. After unref() the parent may exit before a
  // later 'error' event fires; that case is handled by reconcileSessionState
  // noticing the pid is no longer alive.
  child.on("error", (e) => {
    try {
      fs.appendFileSync(pendingLog, JSON.stringify({
        type: "error",
        timestamp: Date.now(),
        error: { name: "SpawnError", data: { message: `cc-oc could not start opencode: ${e.code || e.message}` } }
      }) + "\n");
    } catch { /* ignore — best effort */ }
  });
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);

  // Provisional index entry — sessionId unknown yet, recorded under pending key.
  upsertSession({
    sessionId: pendingId, // will be migrated on first /oc:tail or /oc:sessions
    ccSessionId,
    workspace: cwd || process.cwd(),
    status: "running",
    jobClass: "bg",
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
    filtered.push({ ...record, sessionId: sid, pending: false, updatedAt: new Date().toISOString() });
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
    // Background entry whose log was never created — check PID liveness.
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
