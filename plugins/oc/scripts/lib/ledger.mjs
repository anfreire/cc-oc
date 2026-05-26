// The plugin's session index ledger.
//
// One JSON file at ~/.claude/plugins/data/oc/sessions.json.
// Records the OpenCode sessions WE spawned so /oc:tail, /oc:sessions, /oc:gc
// can filter to ours vs the user's other OpenCode sessions.
//
// Schema:
//   {
//     version: 1,
//     sessions: [
//       {
//         sessionId,        // OpenCode session ID (from session.created event);
//                           // initially the synthetic `_pending_<…>` id assigned
//                           // by startSpawn
//         pendingId,        // after migration: the original `_pending_<…>` id,
//                           // preserved so recovery commands quoted in the
//                           // started-session block stay valid post-migration
//                           // (findSession matches it)
//         pending,          // true between spawn and first observed sessionID,
//                           // false once resolvePendingSession migrates the entry
//         ccSessionId,      // Claude Code session id (best effort, may be null)
//         workspace,        // resolved cwd
//         status,           // queued|running|completed|failed|cancelled|detached
//         model,
//         agent,
//         sandbox,
//         configDir,        // per-spawn OPENCODE_CONFIG_DIR if any (null when no overrides)
//         logFile,
//         pid,              // the opencode child's pid
//         prompt,
//         promptSummary,
//         startedAt,        // ISO
//         updatedAt,
//         completedAt,
//         exitCode,
//         lastAssistantText,
//         errorMessage      // set by reconcileSessionState when the child exited
//                           // before producing any events (no log file)
//       }
//     ]
//   }

import fs from "node:fs";
import path from "node:path";

import { pluginDataRoot } from "./paths.mjs";

const VERSION = 1;

export { pluginDataRoot };

export function indexPath(env = process.env) {
  return path.join(pluginDataRoot(env), "sessions.json");
}

export function logsDir(env = process.env) {
  return path.join(pluginDataRoot(env), "logs");
}

function ensureRoot(env) {
  // 0700 — only the user can read sessions metadata and event logs (which
  // may contain tool inputs and model outputs).
  try {
    fs.mkdirSync(pluginDataRoot(env), { recursive: true, mode: 0o700 });
    fs.mkdirSync(logsDir(env), { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(`cannot create plugin data dir at ${pluginDataRoot(env)} (${e.code || e.message}). Check filesystem permissions.`);
  }
  // Best-effort tighten for pre-existing dirs created with a looser umask.
  try { fs.chmodSync(pluginDataRoot(env), 0o700); } catch { /* skip */ }
  try { fs.chmodSync(logsDir(env), 0o700); } catch { /* skip */ }
}

// Coarse advisory lock for ledger writes. Multiple `oc.mjs` processes spawned
// in parallel can race the load-modify-write cycle. We use an O_EXCL lockfile
// with bounded spin + jitter rather than a real fcntl lock, because the latter
// isn't trivially available across Linux/macOS without a native dep.
export function withLedgerLock(env, fn) {
  ensureRoot(env);
  const lockPath = path.join(pluginDataRoot(env), ".sessions.lock");
  const deadline = Date.now() + 5000;
  let fd = null;
  while (true) {
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) {
        // Stale lock — older than 30s. Take it.
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 30000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore */ }
        throw new Error(`could not acquire ledger lock at ${lockPath} after 5s`);
      }
      const ms = 5 + Math.floor(Math.random() * 25);
      const end = Date.now() + ms;
      while (Date.now() < end) { /* busy wait */ }
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

export function loadIndex(env = process.env) {
  const fp = indexPath(env);
  if (!fs.existsSync(fp)) return { version: VERSION, sessions: [] };
  try {
    const data = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!data || typeof data !== "object" || !Array.isArray(data.sessions)) {
      return { version: VERSION, sessions: [] };
    }
    return { version: data.version ?? VERSION, sessions: data.sessions };
  } catch {
    return { version: VERSION, sessions: [] };
  }
}

// Atomic write: stage to a temp sibling, then rename. POSIX rename is atomic,
// so concurrent readers see either the old file or the new one — never a
// half-written state. Combined with the lockfile above, this gives "no torn
// reads" and (via the lock) "no lost updates." We do not fsync; durability on
// power loss isn't a goal for a transient session index.
export function saveIndex(idx, env = process.env) {
  ensureRoot(env);
  const fp = indexPath(env);
  const tmp = `${fp}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, fp);
  try { fs.chmodSync(fp, 0o600); } catch { /* skip */ }
}

export function upsertSession(record, env = process.env) {
  return withLedgerLock(env, () => {
    const idx = loadIndex(env);
    const existingIdx = idx.sessions.findIndex((s) => s.sessionId === record.sessionId);
    if (existingIdx >= 0) {
      idx.sessions[existingIdx] = { ...idx.sessions[existingIdx], ...record, updatedAt: new Date().toISOString() };
    } else {
      idx.sessions.push({ ...record, updatedAt: new Date().toISOString() });
    }
    saveIndex(idx, env);
    return idx;
  });
}

export function findSession(sessionIdOrPrefix, env = process.env) {
  const idx = loadIndex(env);
  // Exact match on sessionId first, then on the preserved pendingId.
  // After resolvePendingSession migrates a pending entry to its real opencode
  // session id, the original pending id is kept in a `pendingId` field so
  // that any command using the id printed in the started-session block still
  // resolves to the migrated entry. Without this, `/oc:cancel <pendingId>`
  // (printed in the started block) would return not-found after the first
  // `/oc:tail` migrated the row.
  const exactSid = idx.sessions.find((s) => s.sessionId === sessionIdOrPrefix);
  if (exactSid) return exactSid;
  const exactPending = idx.sessions.find((s) => s.pendingId === sessionIdOrPrefix);
  if (exactPending) return exactPending;
  // Prefix match: same precedence — sessionId first, then pendingId.
  const sidCandidates = idx.sessions.filter((s) => s.sessionId.startsWith(sessionIdOrPrefix));
  if (sidCandidates.length === 1) return sidCandidates[0];
  if (sidCandidates.length > 1) {
    throw new Error(`ambiguous session id "${sessionIdOrPrefix}" matches ${sidCandidates.length} sessions`);
  }
  const pendingCandidates = idx.sessions.filter((s) => s.pendingId && s.pendingId.startsWith(sessionIdOrPrefix));
  if (pendingCandidates.length === 1) return pendingCandidates[0];
  if (pendingCandidates.length > 1) {
    throw new Error(`ambiguous pending id "${sessionIdOrPrefix}" matches ${pendingCandidates.length} sessions`);
  }
  return null;
}

export function listSessions({ ccSessionId = null, workspace = null, statuses = null, all = false } = {}, env = process.env) {
  const idx = loadIndex(env);
  return idx.sessions
    .filter((s) => {
      if (all) return true;
      // Scope precedence: ccSessionId first, else workspace, else everything
      // (the last case only reachable via { all: true }, which is handled above).
      if (ccSessionId) return s.ccSessionId === ccSessionId;
      if (workspace) return s.workspace === workspace;
      return true;
    })
    .filter((s) => !statuses || statuses.includes(s.status))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export function latestActiveSession({ ccSessionId, workspace } = {}, env = process.env) {
  const candidates = listSessions({ ccSessionId, workspace, statuses: ["running", "queued"] }, env);
  if (candidates.length > 0) return candidates[0];
  // Fallback: latest matching the same scope regardless of status.
  return listSessions({ ccSessionId, workspace }, env)[0] ?? null;
}

export function logFileFor(sessionId, env = process.env) {
  return path.join(logsDir(env), `${sessionId}.ndjson`);
}
