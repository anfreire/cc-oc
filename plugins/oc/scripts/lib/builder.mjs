// Build a per-spawn OPENCODE_CONFIG_DIR that overrides specific entries in the
// user's existing OpenCode config — without touching what's already there.
//
// OpenCode loads its config in this order (later overrides earlier, deep-merged):
//   1. global  ~/.config/opencode/opencode.json
//   2. project <cwd>/.opencode/opencode.json  (skippable via OPENCODE_DISABLE_PROJECT_CONFIG)
//   3. OPENCODE_CONFIG_DIR/opencode.json      ← this is what we write
//
// We only ever write a tiny override file, never a full config. If a spawn has
// nothing to override, we return { configDir: null } and the caller skips
// setting OPENCODE_CONFIG_DIR entirely — opencode runs against the user's own
// config, unmodified.
//
// Per-spawn dirs go under ~/.claude/plugins/data/oc/runs/<runId>/ so that any
// state opencode writes into OPENCODE_CONFIG_DIR (npm plugin installs, plugin
// state files) lands in a per-run directory we can prune, not in the user's
// real config dir.

import fs from "node:fs";
import path from "node:path";

import { pluginDataRoot } from "./paths.mjs";

function runsDir(env = process.env) {
  return path.join(pluginDataRoot(env), "runs");
}

function hasOverrides(config) {
  const excludeMcps = Array.isArray(config?.opencode?.excludeMcps)
    ? config.opencode.excludeMcps.filter((s) => typeof s === "string" && s.length > 0)
    : [];
  return excludeMcps.length > 0 ? { excludeMcps } : null;
}

function buildOverrideJson({ excludeMcps }) {
  const out = { $schema: "https://opencode.ai/config.json" };
  if (excludeMcps.length > 0) {
    out.mcp = {};
    for (const name of excludeMcps) out.mcp[name] = { enabled: false };
  }
  return out;
}

/**
 * Build (or skip) a per-spawn OPENCODE_CONFIG_DIR.
 *
 * Returns: { configDir: string | null }
 *   - string: pass to opencode as OPENCODE_CONFIG_DIR
 *   - null:   no overrides needed; do NOT set OPENCODE_CONFIG_DIR
 */
export function buildConfigDir({ config, env = process.env } = {}) {
  const overrides = hasOverrides(config);
  if (!overrides) return { configDir: null };

  fs.mkdirSync(runsDir(env), { recursive: true, mode: 0o700 });
  const runId = `${Date.now()}-${process.pid}`;
  const runDir = path.join(runsDir(env), runId);
  fs.mkdirSync(runDir, { mode: 0o700 });

  const body = JSON.stringify(buildOverrideJson(overrides), null, 2) + "\n";
  fs.writeFileSync(path.join(runDir, "opencode.json"), body, { mode: 0o600 });
  return { configDir: runDir };
}
