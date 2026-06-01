import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { readLogState, isPidAlive } from "./tail.mjs";
import {
  logsDir,
  upsertSession,
  withLedgerLock,
  loadIndex,
  saveIndex,
  logFileFor,
} from "./ledger.mjs";

/** @import { SessionRecord } from "./ledger.mjs" */

const PROBE_MS = 20000; // How long to wait for the first session event after spawning opencode before giving up
const TERMINAL_STATUSES = new Set(["done", "error"]);

/**
 * Attempts to kill a process group with the given PID. This is done by sending a SIGTERM signal to the negative of the PID, which targets the entire process group.
 * @param {number} pid - the process ID of the process group to kill
 */
function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* may already be dead */
  }
}

/**
 * Shortens a prompt string to a specified maximum length, while also normalizing whitespace. The function replaces multiple consecutive whitespace characters with a single space, trims leading and trailing whitespace, and then truncates the resulting string to the specified maximum length. This is useful for creating concise summaries of prompts for display purposes, such as in session listings or logs.
 * @param {string} prompt - the original prompt string to shorten
 * @param {number} [max=72] - the maximum length of the shortened prompt; defaults to 72 characters
 * @returns {string} a shortened version of the prompt with normalized whitespace, truncated to the specified maximum length
 */
function shortPrompt(prompt, max = 72) {
  return String(prompt ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Builds the command-line arguments for spawning the `opencode` process based on the provided options. The function constructs an array of arguments that includes the command to run (`run`), the output format (`json`), the working directory, and any specified options such as model, agent, variant, thinking mode, permissions skipping, session ID, and the user prompt. This array of arguments is then used when spawning the `opencode` process to ensure it is executed with the correct parameters.
 * @param {Object} options - the options for building the CLI arguments
 * @param {string} options.cwd - the working directory for the `opencode` process
 * @param {string} [options.model] - optional model name to use for the session
 * @param {string} [options.agent] - optional agent name to use for the session
 * @param {string} [options.variant] - optional variant name to use for the session
 * @param {boolean} [options.thinking=false] - whether to enable thinking mode
 * @param {boolean} [options.pure=false] - whether to run without external plugins
 * @param {boolean} [options.dangerouslySkipPermissions=false] - whether to skip permissions checks (use with caution)
 * @param {string} [options.session] - optional session ID to use for the session
 * @param {string} options.prompt - the user prompt to pass to `opencode`
 * @returns {string[]} an array of command-line arguments to use when spawning the `opencode` process
 */
function buildCliArgs({
  cwd,
  model,
  agent,
  variant,
  thinking,
  pure,
  dangerouslySkipPermissions,
  session,
  prompt,
}) {
  const args = ["run", "--format", "json", "--dir", cwd];
  if (model) args.push("--model", model);
  if (agent) args.push("--agent", agent);
  if (variant) args.push("--variant", variant);
  if (thinking) args.push("--thinking");
  if (pure) args.push("--pure");
  if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (session) args.push("--session", session);
  args.push("--", prompt);
  return args;
}

/**
 * Starts a new `opencode` session by spawning the `opencode` process with the appropriate command-line arguments and environment variables. The function creates a temporary log file for capturing the output of the `opencode` process, then spawns the process in a detached state. It waits for the process to start successfully and then polls the log file for events indicating that the session has been initialized or if any errors have occurred. If a session ID is observed in the logs, it updates the session ledger accordingly. If any errors occur during startup or if no events are observed within a specified timeout, it attempts to kill the process group and returns an error result.
 * @param {Object} options - the options for starting the spawn
 * @param {string} options.binary - the path to the `opencode` binary to execute
 * @param {string} options.prompt - the user prompt to pass to `opencode`
 * @param {string} options.cwd - the working directory for the `opencode` process
 * @param {string} [options.model] - optional model name to use for the session
 * @param {string} [options.agent] - optional agent name to use for the session
 * @param {string} [options.variant] - optional variant name to use for the session
 * @param {boolean} [options.thinking=false] - whether to enable thinking mode
 * @param {boolean} [options.pure=false] - whether to run without external plugins
 * @param {boolean} [options.dangerouslySkipPermissions=false] - whether to skip permissions checks (use with caution)
 * @param {string} [options.session] - optional session ID to use for the session
 * @param {string} [options.ccSessionId] - optional cc session ID to associate with this opencode session (e.g. "s1")
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - environment variables to use when spawning the process and for path resolution; defaults to the current process's environment
 * @return {Promise<{ ok: boolean, sessionId?: string, logFile?: string, pid?: number, message?: string, kind?: string }>} a promise that resolves to an object indicating the result of the spawn attempt, including whether it was successful, the session ID if available, the log file path, the process ID, and any error messages or kinds if it failed
 * @throws {Error} if required options are missing or if there is an error during the spawn process
 */
export async function startSpawn({
  binary,
  prompt,
  cwd,
  model = null,
  agent = null,
  variant = null,
  thinking = false,
  pure = false,
  dangerouslySkipPermissions = false,
  session = null,
  ccSessionId = null,
  env = process.env,
}) {
  fs.mkdirSync(logsDir(env), { recursive: true, mode: 0o700 });
  const tempLog = path.join(
    logsDir(env),
    `.spawning-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.ndjson`,
  );

  let outFd, errFd;
  try {
    outFd = fs.openSync(tempLog, "a", 0o600);
    errFd = fs.openSync(tempLog, "a", 0o600);
  } catch (e) {
    if (outFd !== undefined) {
      try {
        fs.closeSync(outFd);
      } catch {}
    }
    throw new Error(
      `cannot open log file at ${tempLog} (${e.code || e.message})`,
    );
  }

  const args = buildCliArgs({
    cwd,
    model,
    agent,
    variant,
    thinking,
    pure,
    dangerouslySkipPermissions,
    session,
    prompt,
  });
  let child;
  try {
    child = spawn(binary, args, {
      env,
      cwd,
      stdio: ["ignore", outFd, errFd],
      detached: true,
    });
  } finally {
    try {
      fs.closeSync(outFd);
    } catch {}
    try {
      fs.closeSync(errFd);
    } catch {}
  }

  const spawnOutcome = await new Promise((resolve) => {
    let settled = false;
    child.once("spawn", () => {
      if (!settled) {
        settled = true;
        resolve({ ok: true });
      }
    });
    child.once("error", (e) => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: e });
      }
    });
  });
  if (!spawnOutcome.ok) {
    let message;

    if (spawnOutcome.error?.message) {
      message = spawnOutcome.error.message;
    } else if (spawnOutcome.error?.code) {
      message = `Code ${spawnOutcome.error.code}`;
    } else {
      message = "Unknown error";
    }
    return {
      ok: false,
      kind: "spawn-error",
      message,
      logFile: tempLog,
    };
  }

  const probeResult = await new Promise((resolve) => {
    let settled = false;
    let timer, poll;

    const settle = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      child.removeListener("exit", onExit);
      resolve(v);
    };

    const check = () => {
      const state = readLogState(tempLog);
      if (state.errorSeen) return settle({ kind: "error-event", state });
      if (state.observedSessionId) return settle({ kind: "ok", state });
      return false;
    };

    const onExit = (code, signal) => {
      const state = readLogState(tempLog);
      if (state.errorSeen) return settle({ kind: "error-event", state });
      if (state.observedSessionId) return settle({ kind: "ok", state });
      return settle({ kind: "no-events", state, exitCode: code, signal });
    };

    poll = setInterval(check, 100);
    timer = setTimeout(
      () => settle({ kind: "timeout", state: readLogState(tempLog) }),
      PROBE_MS,
    );

    if (typeof timer.unref === "function") timer.unref();
    if (typeof poll.unref === "function") poll.unref();
    child.once("exit", onExit);
  });

  if (probeResult.kind === "timeout") {
    killGroup(child.pid);
    return {
      ok: false,
      kind: "timeout",
      message: `opencode did not produce any event in ${PROBE_MS}ms`,
      logFile: tempLog,
      pid: child.pid,
    };
  }

  if (probeResult.kind === "no-events") {
    const ec = probeResult.exitCode ?? "unknown";
    const sig = probeResult.signal ? ` (signal ${probeResult.signal})` : "";
    return {
      ok: false,
      kind: "no-events",
      message: `opencode exited before producing any event (exit ${ec}${sig})`,
      logFile: tempLog,
      pid: child.pid,
    };
  }

  if (probeResult.kind === "error-event") {
    const sid = probeResult.state.observedSessionId;
    let logFile = tempLog;
    if (sid) {
      const target = logFileFor(sid, env);
      try {
        fs.renameSync(tempLog, target);
        logFile = target;
      } catch {}
      upsertSession(
        {
          sessionId: sid,
          ccSessionId,
          workspace: cwd,
          status: "error",
          model,
          agent,
          logFile,
          pid: child.pid,
          prompt,
          promptSummary: shortPrompt(prompt),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          errorMessage: probeResult.state.errorMessage ?? null,
        },
        env,
      );
    }
    killGroup(child.pid);
    child.unref();
    return {
      ok: false,
      kind: "error-event",
      message: probeResult.state.errorMessage ?? "(no detail)",
      logFile,
      pid: child.pid,
      sessionId: sid ?? null,
    };
  }

  const sid = probeResult.state.observedSessionId;
  let logFile = tempLog;
  const target = logFileFor(sid, env);
  try {
    fs.renameSync(tempLog, target);
    logFile = target;
  } catch {}

  const alive = isPidAlive(child.pid);
  const status = alive ? "running" : "done";
  upsertSession(
    {
      sessionId: sid,
      ccSessionId,
      workspace: cwd,
      status,
      model,
      agent,
      logFile,
      pid: child.pid,
      prompt,
      promptSummary: shortPrompt(prompt),
      startedAt: new Date().toISOString(),
      ...(alive ? {} : { completedAt: new Date().toISOString() }),
    },
    env,
  );

  child.unref();

  return { ok: true, sessionId: sid, logFile, pid: child.pid };
}

/**
 * Reconciles the session state for a given session record. The opencode
 * process pid is the source of truth for termination: while the pid is alive
 * the session stays "running"; once the pid is gone, the log is scanned to
 * decide between "done" (clean exit) and "error" (an error event was emitted).
 * A missing log file with a dead pid is treated as an early-exit error.
 *
 * @param {SessionRecord} record - the session record to reconcile
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @returns {SessionRecord} the updated session record after reconciliation
 */
export function reconcileSessionState(record, env = process.env) {
  if (!record || !record.logFile) return record;
  if (TERMINAL_STATUSES.has(record.status)) return record;
  if (!record.pid || isPidAlive(record.pid)) return record;

  let status, errorMessage;
  if (!fs.existsSync(record.logFile)) {
    status = "error";
    errorMessage = "opencode exited before producing any events";
  } else {
    const state = readLogState(record.logFile);
    status = state.errorSeen ? "error" : "done";
    errorMessage = state.errorSeen ? state.errorMessage : null;
  }

  return withLedgerLock(() => {
    const idx = loadIndex(env);
    const filtered = idx.sessions.filter(
      (s) => s.sessionId !== record.sessionId,
    );
    const updated = {
      ...record,
      status,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(errorMessage ? { errorMessage } : {}),
    };
    filtered.push(updated);
    idx.sessions = filtered;
    saveIndex(idx, env);
    return updated;
  }, env);
}

/**
 * Attempts to cancel a session by sending an abort command to the `opencode` process if a session ID and `opencode` binary path are available, and then killing the process group. It also updates the session record in the ledger to mark it as done with a completed timestamp. This function is used to gracefully handle session cancellations initiated by the user.
 * @param {SessionRecord} record - the session record to cancel
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @param {string|null} [opencodeBin=null] - the path to the `opencode` binary to use for sending the abort command; if null, the abort command will not be sent
 */
export function cancelSession(record, env = process.env, opencodeBin = null) {
  if (record.sessionId && opencodeBin) {
    try {
      spawnSync(opencodeBin, ["session", "abort", record.sessionId], {
        env,
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {}
  }
  
  killGroup(record.pid);
  upsertSession(
    {
      sessionId: record.sessionId,
      status: "done",
      completedAt: new Date().toISOString(),
    },
    env,
  );
}
