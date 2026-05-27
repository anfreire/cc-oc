import path from "node:path";
import os from "node:os";

/**
 * Returns the root directory for Claude-related data, determined by the `CLAUDE_HOME` environment variable or defaulting to `~/.claude`. This is the base directory under which all plugin data, including session logs and indexes, will be stored. By allowing `CLAUDE_HOME` to override the default path, users can customize where their data is stored, which can be useful for various deployment scenarios or personal preferences.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @returns {string} the root directory for Claude-related data, determined by the `CLAUDE_HOME` environment variable or defaulting to `~/.claude`
 */
export function claudeRoot(env = process.env) {
  if (env.CLAUDE_HOME && env.CLAUDE_HOME.trim() !== "") return env.CLAUDE_HOME;
  return path.join(env.HOME || os.homedir(), ".claude");
}

/**
 * Returns the plugin data root directory, which is a subdirectory under the Claude root directory specifically for this plugin's data. This function constructs the path to the plugin's data directory, which is where session logs and indexes will be stored. By organizing plugin data under a specific subdirectory, it helps keep the file system organized and makes it easier to manage data for multiple plugins if necessary.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Optional environment variables to determine paths; defaults to the current process's environment.
 * @returns {string} the file path to the plugin data root directory, which is a subdirectory under the Claude root directory
 */
export function pluginDataRoot(env = process.env) {
  return path.join(claudeRoot(env), "plugins", "data", "oc");
}
