// Shared filesystem-path helpers.
//
// CLAUDE_HOME overrides the default `~/.claude` root for every cc-oc path —
// the user's config file (`~/.claude/oc.json`), the plugin data dir
// (`~/.claude/plugins/data/oc/`), session logs, and the ledger all sit under
// it. Centralizing this in one helper means CLAUDE_HOME applies uniformly;
// having each module compute it locally invites drift (e.g. config respecting
// it but the ledger silently writing to $HOME/.claude anyway).

import path from "node:path";
import os from "node:os";

export function claudeRoot(env = process.env) {
  if (env.CLAUDE_HOME && env.CLAUDE_HOME.trim() !== "") return env.CLAUDE_HOME;
  return path.join(env.HOME || os.homedir(), ".claude");
}

export function pluginDataRoot(env = process.env) {
  return path.join(claudeRoot(env), "plugins", "data", "oc");
}
