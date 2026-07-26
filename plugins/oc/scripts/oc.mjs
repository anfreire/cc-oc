#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  startSpawn,
  reconcileSessionState,
  cancelSession,
} from "./lib/spawn.mjs";
import { renderLog, readLogState } from "./lib/log.mjs";
import { findOpencodeBinary, sessionTitles } from "./lib/opencode-bin.mjs";
import { findSession, listSessions, logsDir } from "./lib/ledger.mjs";

// stdout/stderr may be a pipe the consumer closes early (`debug <id> | head`);
// dying with an unhandled EPIPE stack helps no one — exit quietly, SIGPIPE-style.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });
}

const SUBCMDS = new Set(["spawn", "wait", "debug", "sessions", "cancel", "gc"]);
const ARGS_SPEC = {
  spawn: {
    dir: { type: "string" },
    model: { type: "string" },
    agent: { type: "string" },
    variant: { type: "string" },
    thinking: { type: "boolean" },
    pure: { type: "boolean" },
    "dangerously-skip-permissions": { type: "boolean" },
    session: { type: "string" },
  },
  wait: {},
  debug: {},
  sessions: {},
  cancel: {},
  gc: {},
};
const RETENTION_DAYS = 14;
const RETENTION_MAX_MB = 500;

/**
 * Prints an error message to stderr and exits with the given code (default 1). Used for fatal errors like invalid usage or missing opencode binary.
 * @param {string} msg - the error message to print
 * @param {number} [code=1] - the exit code to use (default 1)
 */
function die(msg, code = 1) {
  process.stderr.write(`oc: ${msg}\n`);
  process.exit(code);
}

/**
 * Retrieves the current Claude Code session ID from the `CLAUDE_CODE_SESSION_ID` environment variable. This is used to associate spawned OpenCode sessions with the current Claude Code session, allowing for better organization and filtering of sessions when listing or inspecting them.
 * @returns {string|null} the current Claude Code session ID if set, or null if not set
 */
function ccSessionIdFromEnv() {
  return process.env.CLAUDE_CODE_SESSION_ID || null;
}

/**
 * Parses command-line arguments into flags and positionals based on a provided specification. Flags are expected to be in the form `--flag` or `--flag=value`, and positionals are any arguments that don't match the flag pattern. The function validates flags against the provided specification, ensuring required values are present and of the correct type.
 * @param {string[]} argv - the array of command-line arguments to parse (excluding the subcommand)
 * @param {Object} spec - an object defining expected flags and their types (e.g., `{ flagName: { type: "string" | "boolean" } }`)
 * @returns {{ flags: Object, positionals: string[] }} an object containing parsed flags and positionals
 * @throws {Error} if an unknown flag is encountered, if a flag value is missing, or if a flag value is of the wrong type
 */
function parseArgs(argv, spec) {
  const flags = {};
  const positionals = [];
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];

    if (t === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const key = eq >= 0 ? t.slice(2, eq) : t.slice(2);
      const inline = eq >= 0 ? t.slice(eq + 1) : undefined;
      const def = spec[key];
      if (!def) throw new Error(`unknown flag: --${key}`);

      if (def.type === "boolean") {
        flags[key] =
          inline === undefined
            ? true
            : inline.toLowerCase() === "true" || inline === "1";
        i++;
        continue;
      }

      if (inline !== undefined) {
        flags[key] = inline;
        i++;
        continue;
      }

      const v = argv[i + 1];
      if (v === undefined) throw new Error(`--${key} expects a value`);

      flags[key] = v;

      i += 2;

      continue;
    }
    positionals.push(t);
    i++;
  }
  return { flags, positionals };
}

/**
 * Formats a timestamp as a relative time string (e.g., "5s ago", "3m ago",
 * "2h ago", "4d ago"). Accepts either an ISO 8601 string or milliseconds since
 * epoch. Returns "?" for null, undefined, unparseable input, or future times.
 *
 * @param {string|number|null|undefined} when - the timestamp to format
 * @returns {string} a relative time string, or "?" if the input is invalid
 */
function relTime(when) {
  if (when == null) return "?";
  const t = typeof when === "number" ? when : Date.parse(when);
  if (!Number.isFinite(t)) return "?";
  const ms = Date.now() - t;
  if (ms < 0) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Handles the `spawn` subcommand, which starts a new OpenCode session based on a prompt read from stdin. The function validates the input, checks for the presence of the OpenCode binary, and then invokes the `startSpawn` function with the appropriate parameters. It also handles outputting the result of the spawn operation, including any errors that occur during startup.
 * @param {string[]} argv - the command-line arguments passed to the `spawn` subcommand (excluding the subcommand itself)
 * @returns {Promise<void>} a promise that resolves when the command has completed
 */
async function cmdSpawn(argv) {
  const { flags, positionals } = parseArgs(argv, ARGS_SPEC.spawn);
  if (positionals.length > 0) {
    die(
      `unexpected token(s) after flags: ${JSON.stringify(positionals.join(" "))} — spawn reads the prompt from stdin via heredoc`,
    );
  }

  const prompt = await readStdin();
  if (!prompt || prompt.trim() === "") {
    die(
      "missing prompt — pipe it on stdin: `oc.mjs spawn [flags] <<'PROMPT'\\n<body>\\nPROMPT`",
    );
  }

  const env = process.env;
  const bin = findOpencodeBinary({ env });
  if (!bin)
    die(
      "opencode binary not found on PATH. Install it (`curl -fsSL https://opencode.ai/install | bash`) and rerun.",
    );

  const cwd = flags.dir || process.cwd();
  if (flags.dir) {
    try {
      const st = fs.statSync(cwd);
      if (!st.isDirectory()) die(`--dir is not a directory: ${cwd}`);
    } catch {
      die(`--dir does not exist: ${cwd}`);
    }
  }

  const result = await startSpawn({
    binary: bin,
    prompt: prompt.replace(/\n+$/, ""),
    cwd,
    model: flags.model || null,
    agent: flags.agent || null,
    variant: flags.variant || null,
    thinking: Boolean(flags.thinking),
    pure: Boolean(flags.pure),
    dangerouslySkipPermissions: Boolean(flags["dangerously-skip-permissions"]),
    session: flags.session || null,
    ccSessionId: ccSessionIdFromEnv(),
    env,
  });

  if (!result.ok) {
    const recoveryDoc = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "reference",
      "recovery.md",
    );
    process.stderr.write(`OpenCode failed to start.\n`);
    process.stderr.write(`error:    ${result.message}\n`);
    if (result.sessionId) {
      process.stderr.write(`debug:    /oc:debug ${result.sessionId}\n`);
    } else {
      process.stderr.write(`log:      ${result.logFile}\n`);
    }
    process.stderr.write(`recovery: ${recoveryDoc}\n`);
    process.exit(1);
  }

  process.stdout.write(`Started OpenCode session.\n`);
  process.stdout.write(`session: ${result.sessionId}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(
    `Get the answer (a notification arrives when the session ends):\n`,
  );
  process.stdout.write(`  Monitor({\n`);
  process.stdout.write(
    `    command: 'node "${fileURLToPath(import.meta.url)}" wait ${result.sessionId} 2>&1',\n`,
  );
  process.stdout.write(
    `    description: "opencode session ${result.sessionId}",\n`,
  );
  process.stdout.write(`    persistent: true,\n`);
  process.stdout.write(`  })\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Inspect or manage:\n`);
  const sid = result.sessionId;
  const rows = [
    [`/oc:debug ${sid}`, "status + full event trace"],
    [`/oc:cancel ${sid}`, "abort"],
    [`/oc:sessions`, "list sessions"],
  ];
  const cmdWidth = Math.max(...rows.map(([cmd]) => cmd.length));
  for (const [cmd, desc] of rows) {
    process.stdout.write(`  ${cmd.padEnd(cmdWidth)}  ${desc}\n`);
  }
}

/**
 * Handles the `debug` subcommand: the way to inspect a session's progress or
 * failures without touching the raw NDJSON log. Prints a short status header
 * (session id, ledger status, last-activity time) followed by the session's
 * full rendered event trace — model text, tool calls, errors, stderr. One
 * output shape for every session state: a running session shows its trace so
 * far, a finished one the whole run, and a missing or empty log renders as
 * "(no events)". The final answer stays `wait`'s job.
 * @param {string[]} argv - the command-line arguments passed to the `debug` subcommand (excluding the subcommand itself)
 * @returns {Promise<void>} a promise that resolves when the command has completed
 */
async function cmdDebug(argv) {
  const { positionals } = parseArgs(argv, ARGS_SPEC.debug);
  if (positionals.length !== 1) die("usage: /oc:debug <session-id>");

  const env = process.env;
  let record = findSession(positionals[0], env);
  if (!record) die(`no session matches "${positionals[0]}"`);

  record = reconcileSessionState(record, env);
  const trace = renderLog(record.logFile);
  const { lastEventAt } = readLogState(record.logFile);

  process.stdout.write(`session:  ${record.sessionId}\n`);
  process.stdout.write(`status:   ${record.status}\n`);
  process.stdout.write(`activity: ${relTime(lastEventAt)}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(trace ? `${trace}\n` : `(no events)\n`);
}

/**
 * Handles the `wait` subcommand, which blocks until a spawned OpenCode session
 * reaches a terminal state, then returns the result: the agent's final answer
 * on stdout for a clean finish, or a terse error line on stderr (exit 1) on
 * failure. This is the canonical "get the answer" path — run it under Monitor
 * (`persistent: true`, stderr merged) and the completion ping carries the
 * answer, so there's no separate read step. The full event trace stays opt-in
 * behind `debug`, so `wait` returns the deliverable, not the noise. For a pure
 * completion barrier with no output, redirect: `wait <id> > /dev/null` (errors
 * still surface on stderr). The opencode process dying is the only termination
 * signal, so every terminal state is surfaced, not just success. A session
 * cancelled via `/oc:cancel` is reported as cancelled (stderr, exit 1) rather
 * than having its partial output passed off as a clean answer.
 * @param {string[]} argv - the command-line arguments passed to the `wait` subcommand (excluding the subcommand itself)
 * @returns {Promise<void>} a promise that resolves when the command has completed
 */
async function cmdWait(argv) {
  const { positionals } = parseArgs(argv, ARGS_SPEC.wait);
  if (positionals.length !== 1) die("usage: /oc:wait <session-id>");

  const env = process.env;
  let record = findSession(positionals[0], env);
  if (!record) die(`no session matches "${positionals[0]}"`);

  record = reconcileSessionState(record, env);
  while (record.status === "running") {
    await new Promise((r) => setTimeout(r, 1000));
    record = reconcileSessionState(record, env);
  }

  // A cancelled session is terminal but not a clean finish: its log may hold
  // partial model text that must not be passed off as the answer. Report the
  // cancellation and exit 1 rather than emitting that partial text.
  if (record.status === "cancelled") {
    process.stderr.write(
      `session ${record.sessionId} cancelled\n`,
    );
    process.exitCode = 1;
    return;
  }

  const state = readLogState(record.logFile);

  // Treat a logged error event as a failure even if the ledger says "done":
  // a session can be stamped terminal before a late error event is written.
  if (record.status === "error" || state.errorSeen) {
    const msg = record.errorMessage ?? state.errorMessage ?? "(no detail)";
    process.stderr.write(`session ${record.sessionId} error: ${msg}\n`);
    process.exitCode = 1;
    return;
  }

  // The final assistant turn (text since the last step boundary) is the take.
  const answer = (state.finalText ?? "").replace(/\s+$/, "");
  if (answer) {
    process.stdout.write(answer + "\n");
    return;
  }

  // Finished cleanly but produced no model text (e.g. a tool-only run). Keep
  // stdout answer-only — the diagnostic goes to stderr.
  process.stderr.write(
    `session ${record.sessionId} finished with no model text — see /oc:debug ${record.sessionId}\n`,
  );
}

/**
 * Handles the `sessions` subcommand, which lists all OpenCode sessions associated with the current Claude Code session. The function retrieves session records, reconciles their states based on log files, and then outputs a formatted list of sessions including their IDs, relative start times, statuses, and prompt summaries.
 * @param {string[]} argv - the command-line arguments passed to the `sessions` subcommand (excluding the subcommand itself)
 * @returns {Promise<void>} a promise that resolves when the command has completed
 */
async function cmdSessions(argv) {
  const { positionals } = parseArgs(argv, ARGS_SPEC.sessions);

  if (positionals.length > 0) {
    die(
      `unexpected token(s): ${JSON.stringify(positionals.join(" "))} — sessions takes no arguments`,
    );
  }

  const env = process.env;
  const cc = ccSessionIdFromEnv();
  if (!cc)
    die(
      "CLAUDE_CODE_SESSION_ID is unset; /oc:sessions only lists sessions in the current Claude Code session",
    );

  const raw = listSessions(cc, env);
  const sessions = raw.map((s) => reconcileSessionState(s, env));
  if (sessions.length === 0) {
    process.stdout.write("(no sessions)\n");
    return;
  }

  const titles = sessionTitles(env);
  const rows = sessions.map((s) => ({
    sessionId: s.sessionId,
    activity: relTime(s.logFile ? readLogState(s.logFile).lastEventAt : null),
    status: s.status,
    prompt: titles.get(s.sessionId) || s.promptSummary || "",
  }));

  const idW = Math.max("session".length, ...rows.map((r) => r.sessionId.length));
  const activityW = Math.max("activity".length, ...rows.map((r) => r.activity.length));
  const statusW = Math.max("status".length, ...rows.map((r) => r.status.length));

  process.stdout.write(
    `${"session".padEnd(idW)}  ${"activity".padEnd(activityW)}  ${"status".padEnd(statusW)}  prompt\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${r.sessionId.padEnd(idW)}  ` +
        `${r.activity.padEnd(activityW)}  ` +
        `${r.status.padEnd(statusW)}  ` +
        `${r.prompt}\n`,
    );
  }
}

/**
 * Handles the `cancel` subcommand, which aborts a running OpenCode session. The function validates the input session ID, checks if the session is currently running, and if so, invokes the `cancelSession` function to attempt to cancel it. It also handles outputting the result of the cancellation attempt.
 * @param {string[]} argv - the command-line arguments passed to the `cancel` subcommand (excluding the subcommand itself)
 * @returns {Promise<void>} a promise that resolves when the command has completed
 */
async function cmdCancel(argv) {
  const { positionals } = parseArgs(argv, ARGS_SPEC.cancel);
  if (positionals.length !== 1) {
    die("usage: /oc:cancel <session-id>");
  }

  const env = process.env;
  let record = findSession(positionals[0], env);
  if (!record) die(`no session "${positionals[0]}"`);

  record = reconcileSessionState(record, env);
  if (record.status !== "running") {
    process.stdout.write(
      `session ${record.sessionId} is already ${record.status}; no-op\n`,
    );
    return;
  }

  const bin = findOpencodeBinary({ env });
  cancelSession(record, env, bin);
  process.stdout.write(`cancelled ${record.sessionId}\n`);
}

/**
 * Handles the `gc` subcommand, which performs garbage collection on session logs. The function deletes log files for sessions that are older than a specified retention period (e.g., 14 days) and also ensures that the total size of log files does not exceed a specified maximum (e.g., 500 MB) by deleting the oldest logs first until the size constraint is met.
 * @param {string[]} argv - the command-line arguments passed to the `gc` subcommand (excluding the subcommand itself)
 * @returns {Promise<void>} a promise that resolves when the command has completed
 */
async function cmdGc(_argv) {
  const env = process.env;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const maxBytes = RETENTION_MAX_MB * 1024 * 1024;
  const root = logsDir(env);
  if (!fs.existsSync(root)) return;

  const surviving = [];
  for (const f of fs.readdirSync(root)) {
    const fp = path.join(root, f);
    try {
      const st = fs.statSync(fp);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
      } else surviving.push({ fp, mtimeMs: st.mtimeMs, size: st.size });
    } catch {}
  }
  surviving.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = surviving.reduce((s, x) => s + x.size, 0);
  while (total > maxBytes && surviving.length > 0) {
    const drop = surviving.shift();
    try {
      fs.unlinkSync(drop.fp);
      total -= drop.size;
    } catch {}
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

const HELP = `oc <subcommand> [args]

Subcommands:
  spawn     start an opencode session (prompt on stdin via heredoc)
  wait      block until a session finishes, then print its final answer (or error)
  debug     print a session's status and full event trace
  sessions  list sessions in this Claude Code session
  cancel    abort a running session

Spawn flags (all optional, all pass through to \`opencode run\`):
  --dir <path>                        workspace root (default: pwd)
  --model <id>                        opencode model id (provider/model form)
  --agent <name>                      pin an opencode agent
  --variant <tier>                    reasoning-effort variant
  --thinking                          show reasoning blocks
  --pure                              run without external plugins
  --dangerously-skip-permissions      bypass opencode permission prompts
  --session <session-id>                     resume a specific opencode session

\`debug\` and \`wait\` split the two jobs: \`debug\` shows the event trace, \`wait\`
returns the final answer. Both take exactly one <session-id> and no flags.
`;

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (!SUBCMDS.has(sub)) die(`unknown subcommand: ${sub}`);
  const rest = argv.slice(1);
  try {
    if (sub === "spawn") await cmdSpawn(rest);
    else if (sub === "wait") await cmdWait(rest);
    else if (sub === "debug") await cmdDebug(rest);
    else if (sub === "sessions") await cmdSessions(rest);
    else if (sub === "cancel") await cmdCancel(rest);
    else if (sub === "gc") await cmdGc(rest);
  } catch (e) {
    die(e.message || String(e));
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
