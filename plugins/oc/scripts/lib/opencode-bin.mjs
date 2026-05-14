// Discover the `opencode` binary on PATH (or via $OPENCODE_BIN override).

import fs from "node:fs";
import { spawnSync } from "node:child_process";

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findOpencodeBinary({ env = process.env } = {}) {
  // 1. Explicit override. We refuse to silently fall through to PATH if the
  // user set OPENCODE_BIN — a misconfigured override should fail loudly, not
  // pick up some unrelated binary that happens to be on PATH.
  if (env.OPENCODE_BIN && env.OPENCODE_BIN.trim() !== "") {
    const candidate = env.OPENCODE_BIN.trim();
    if (isExecutable(candidate)) return candidate;
    throw new Error(`OPENCODE_BIN is set to ${JSON.stringify(candidate)} but that path is not executable.`);
  }
  // 2. PATH lookup via `which`.
  const which = spawnSync("which", ["opencode"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim() !== "") return which.stdout.trim();
  return null;
}
