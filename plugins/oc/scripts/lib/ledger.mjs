import fs from "node:fs";
import path from "node:path";

import { pluginDataRoot } from "./paths.mjs";

/**
 * @typedef {Object} SessionRecord
 * @property {string} sessionId - opaque unique id for this session (e.g. "a1b2c3d4")
 * @property {string} ccSessionId - the cc session this opencode session is associated with (e.g. "s1")
 * @property {string} prompt - the user prompt that triggered this session
 * @property {string} status - one of "running", "completed", "failed"
 * @property {string} updatedAt - ISO timestamp of last update to this record
 */

/**
 * @typedef {Object} SessionIndex
 * @property {number} version - index format version (currently 1)
 * @property {SessionRecord[]} sessions - list of all sessions, sorted by updatedAt desc
 */

const VERSION = 1;

/**
 * Returns the file path to the session index JSON file, which stores metadata about all recorded sessions. The path is determined based on the plugin data root directory, which can be overridden by the `CLAUDE_HOME` environment variable.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @returns {string} the file path to the session index JSON file
 */
export function indexPath(env = process.env) {
  return path.join(pluginDataRoot(env), "sessions.json");
}

/**
 * Returns the logs directory path, which is where individual session log files are stored. The path is determined based on the plugin data root directory, which can be overridden by the `CLAUDE_HOME` environment variable.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @returns {string} the file path to the logs directory
 */
export function logsDir(env = process.env) {
  return path.join(pluginDataRoot(env), "logs");
}

/**
 * Returns the file path for a specific session's log file, which is an NDJSON file named after the session ID. The logs are stored in the logs directory under the plugin data root.
 * @param {string} sessionId - the session ID to get the log file path for
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @returns {string} the file path to the specified session's log file
 */
export function logFileFor(sessionId, env = process.env) {
  return path.join(logsDir(env), `${sessionId}.ndjson`);
}

/**
 * Ensures that the plugin data root directory and logs directory exist with restrictive permissions (0700). If the directories cannot be created, an error is thrown. This function is called before any operations that read or write session data to ensure the necessary directories are in place.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @throws {Error} if the plugin data root or logs directory cannot be created
 */
function ensureRoot(env) {
  try {
    fs.mkdirSync(pluginDataRoot(env), { recursive: true, mode: 0o700 });
    fs.mkdirSync(logsDir(env), { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(
      `cannot create plugin data dir at ${pluginDataRoot(env)} (${e.code || e.message})`,
    );
  }

  try {
    fs.chmodSync(pluginDataRoot(env), 0o700);
  } catch {}

  try {
    fs.chmodSync(logsDir(env), 0o700);
  } catch {}
}

/**
 * Acquires a lock on the ledger (session index) to safely execute `fn` without race conditions from other processes.
 * @param {Function} fn - function to execute with the ledger lock held. Should return quickly; if it takes more than 5s to complete, other processes will be able to acquire the lock and potentially
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @returns the return value of `fn()`
 */
export function withLedgerLock(fn, env = process.env) {
  ensureRoot(env);

  const lockPath = path.join(pluginDataRoot(env), ".sessions.lock");
  const deadline = Date.now() + 5000; // 5s timeout to acquire lock
  let fd = null;
  while (true) {
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) {
        try {
          const st = fs.statSync(lockPath);

          // lock is stale after 30s
          if (Date.now() - st.mtimeMs > 30000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {}

        throw new Error(
          `could not acquire ledger lock at ${lockPath} after 5s`,
        );
      }

      const end = Date.now() + 5 + Math.floor(Math.random() * 25);
      while (Date.now() < end) {
        /* spin */
      }
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}

    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}

/**
 * Loads the session index from disk, returning an object with `version` and `sessions` fields. If the index file doesn't exist or is malformed, returns a default object with an empty sessions list.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @returns {SessionIndex}
 */
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

/**
 * Saves the given session index object to disk, atomically writing to a temp file and renaming it over the old index. The index is stored with restrictive permissions (0600) to prevent other users on the system from reading or modifying it.
 * @param {SessionIndex} idx - the session index object to save to disk
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 */
export function saveIndex(idx, env = process.env) {
  ensureRoot(env);

  const fp = indexPath(env);
  const tmp = `${fp}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, fp);

  try {
    fs.chmodSync(fp, 0o600);
  } catch {}
}

/**
 * Upserts a session record in the index: if a record with the same `sessionId` already exists, it's updated with the new data and `updatedAt` timestamp; otherwise, the new record is added to the index. The updated index is saved to disk.
 * @param {SessionRecord} record - the session record to upsert into the index
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @returns {SessionIndex} the updated session index after upserting the record
 */
export function upsertSession(record, env = process.env) {
  return withLedgerLock(() => {
    const idx = loadIndex(env);
    const existingIdx = idx.sessions.findIndex(
      (s) => s.sessionId === record.sessionId,
    );
    if (existingIdx >= 0) {
      idx.sessions[existingIdx] = {
        ...idx.sessions[existingIdx],
        ...record,
        updatedAt: new Date().toISOString(),
      };
    } else {
      idx.sessions.push({ ...record, updatedAt: new Date().toISOString() });
    }
    saveIndex(idx, env);
    return idx;
  }, env);
}

/**
 * Finds a session record by its `sessionId`. If an exact match isn't found, attempts to find a unique partial match where the `sessionId` starts with the given string (e.g. "a1b2c3" would match "a1b2c3d4"). If multiple partial matches are found, an error is thrown due to ambiguity. If no matches are found, null is returned.
 * @param {string} sessionId - the session id to search for (can be full or prefix)
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @returns {SessionRecord|null} the matching session record, or null if not found
 */
export function findSession(sessionId, env = process.env) {
  const idx = loadIndex(env);
  const exact = idx.sessions.find((s) => s.sessionId === sessionId);
  if (exact) return exact;

  const candidates = idx.sessions.filter((s) =>
    s.sessionId.startsWith(sessionId),
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous session id "${sessionId}" matches ${candidates.length} sessions`,
    );
  }

  return null;
}

/**
 * Lists session records, optionally filtering by `ccSessionId` to only include sessions associated with a specific Claude Code session. The returned list is sorted by `updatedAt` in descending order (most recently updated sessions first).
 * @param {string} [ccSessionId] - optional Claude Code session id to filter sessions by; if not provided, all sessions are returned
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @returns {SessionRecord[]} list of session records matching the filter criteria, sorted by most recently updated
 */
export function listSessions(ccSessionId, env = process.env) {
  const idx = loadIndex(env);
  return idx.sessions
    .filter((s) => !ccSessionId || s.ccSessionId === ccSessionId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}
