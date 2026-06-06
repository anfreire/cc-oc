import fs from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Checks if the given path is executable by the current user.
 * @param {fs.PathLike} p - the path to check for executability
 * @returns {boolean} true if the path is executable, false otherwise
 */
function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the `opencode` binary in the system. First checks if the `OPENCODE_BIN` environment variable is set and points to an executable file. If not, uses the `which` command to search for `opencode` in the system's PATH. If found, returns the path to the binary; otherwise, returns null.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to check for `OPENCODE_BIN` and to pass to the `which` command; defaults to the current process's environment.
 * @returns {string|null} the path to the `opencode` binary if found and executable, or null if not found or not executable
 * @throws {Error} if `OPENCODE_BIN` is set but does not point to an executable file
 */
export function findOpencodeBinary({ env = process.env } = {}) {
  if (env.OPENCODE_BIN && env.OPENCODE_BIN.trim() !== "") {
    const candidate = env.OPENCODE_BIN.trim();
    if (isExecutable(candidate)) return candidate;
    throw new Error(
      `OPENCODE_BIN is set to ${JSON.stringify(candidate)} but that path is not executable.`,
    );
  }

  const which = spawnSync("which", ["opencode"], { env, encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim() !== "")
    return which.stdout.trim();

  return null;
}

/**
 * Runs `opencode <args>` and parses its stdout as JSON, returning the parsed
 * value or `null` on any failure — binary missing/invalid, non-zero exit, empty
 * or unparseable output, the 3s timeout, or any thrown error. Never throws.
 * @param {string[]} args - arguments to pass to `opencode`
 * @param {NodeJS.ProcessEnv} [env=process.env] - environment for resolution and the spawned process
 * @returns {any|null} the parsed JSON, or null on any failure
 */
function opencodeJson(args, env = process.env) {
  try {
    const bin = findOpencodeBinary({ env });
    if (!bin) return null;
    const r = spawnSync(bin, args, {
      env,
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 1 << 23,
    });
    return r.status === 0 && r.stdout ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

/**
 * Builds a Map of opencode session id → its generated title from `opencode
 * session list --format json`. Empty titles and opencode's `New session - <ts>`
 * placeholder are dropped; returns an empty Map on any failure — so callers fall
 * back to their own summary whenever a real title isn't available yet.
 * @param {NodeJS.ProcessEnv} [env=process.env] - environment for the opencode call
 * @returns {Map<string, string>} session id → title (non-empty titles only)
 */
export function sessionTitles(env = process.env) {
  const list = opencodeJson(["session", "list", "--format", "json"], env);
  if (!Array.isArray(list)) return new Map();
  return new Map(
    list
      .map((s) => [s.id, typeof s.title === "string" ? s.title.trim() : ""])
      .filter(([, t]) => t && !/^New session - \d{4}-\d\d-\d\dT/.test(t)),
  );
}
