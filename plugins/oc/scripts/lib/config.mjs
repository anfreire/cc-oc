// Load + validate the user's plugin config from ~/.claude/oc.json.
// Returns a normalized config with defaults applied.
//
// The config only ever describes how the plugin LAUNCHES opencode — defaults
// for /oc:spawn flags + log retention. The plugin does not synthesize any
// opencode-side state; opencode's own config (global + project) is the source
// of truth.

import fs from "node:fs";
import path from "node:path";

import { claudeRoot } from "./paths.mjs";

export const DEFAULT_CONFIG = Object.freeze({
  opencode: {
    model: null,
    variant: null,
    agent: null,
    sandbox: "read-only",
    disableProjectConfig: false,
    pure: false,
    excludeMcps: []
  },
  retention: {
    logsDays: 14,
    maxLogsMb: 500
  }
});

export function defaultConfigPath(env = process.env) {
  return path.join(claudeRoot(env), "oc.json");
}

function stripJsoncComments(text) {
  // Minimal: strip // line comments and /* */ block comments.
  // Doesn't try to be JSONC-strict — good enough for hand-written config files.
  let out = "";
  let i = 0;
  let inString = false;
  let stringChar = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      if (ch === "\\") { out += ch + (next ?? ""); i += 2; continue; }
      out += ch;
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; stringChar = ch; out += ch; i++; continue; }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch; i++;
  }
  return out;
}

export function loadUserConfig({ filePath = null, env = process.env } = {}) {
  const fp = filePath ?? defaultConfigPath(env);
  if (!fs.existsSync(fp)) return { config: structuredClone(DEFAULT_CONFIG), rawConfig: null, source: null, exists: false };
  let raw;
  try { raw = fs.readFileSync(fp, "utf8"); } catch (e) {
    throw new Error(`failed to read ${fp}: ${e.message}`);
  }
  let parsed;
  try { parsed = JSON.parse(stripJsoncComments(raw)); } catch (e) {
    throw new Error(`${fp} is not valid JSON: ${e.message}`);
  }
  // rawConfig is the parsed-but-not-defaulted config; validateConfig runs on it
  // so that a non-object opencode/retention block is caught instead of dropped.
  return { config: applyDefaults(parsed), rawConfig: parsed, source: fp, exists: true };
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Merge user overrides on top of defaults, one shallow level deep per known
// section. Unknown top-level keys are preserved verbatim but ignored at runtime;
// schema-aware editors can still flag them without blocking a spawn.
export function applyDefaults(user) {
  const u = isPlainObject(user) ? user : {};
  const out = structuredClone(DEFAULT_CONFIG);
  for (const k of Object.keys(u)) {
    if (k === "opencode" || k === "retention") {
      if (isPlainObject(u[k])) Object.assign(out[k], u[k]);
    } else {
      out[k] = u[k];
    }
  }
  return out;
}

function checkStringOrNull(value, label, errors) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") errors.push(`${label} must be a string or null`);
}

function checkBoolean(value, label, errors) {
  if (value === undefined) return;
  if (typeof value !== "boolean") errors.push(`${label} must be a boolean`);
}

function checkInteger(value, label, errors, { min = null } = {}) {
  if (value === undefined) return;
  if (!Number.isInteger(value)) { errors.push(`${label} must be an integer`); return; }
  if (min !== null && value < min) errors.push(`${label} must be >= ${min}`);
}

function checkStringArray(value, label, errors) {
  if (value === undefined) return;
  if (!Array.isArray(value)) { errors.push(`${label} must be an array of strings`); return; }
  for (const item of value) {
    if (typeof item !== "string") { errors.push(`${label} entries must be strings`); return; }
  }
}

export function validateConfig(config) {
  const errors = [];
  if (!isPlainObject(config)) {
    return { ok: false, errors: ["config must be an object"] };
  }
  // Runtime validation only covers values cc-oc consumes directly. Unknown keys
  // are ignored so editor schema feedback never becomes a spawn-time blocker.
  // $schema is conventional metadata pointing at a JSON-schema URL; only ever a string.
  if (config.$schema !== undefined && typeof config.$schema !== "string") {
    errors.push("$schema must be a string");
  }

  const oc = config.opencode;
  if (oc !== undefined) {
    if (!isPlainObject(oc)) {
      errors.push("opencode must be an object");
    } else {
      checkStringOrNull(oc.model, "opencode.model", errors);
      checkStringOrNull(oc.variant, "opencode.variant", errors);
      checkStringOrNull(oc.agent, "opencode.agent", errors);
      const validSandbox = new Set(["read-only", "workspace-write"]);
      if (oc.sandbox !== undefined && !validSandbox.has(oc.sandbox)) {
        errors.push(`opencode.sandbox must be one of: ${[...validSandbox].join(", ")}`);
      }
      checkBoolean(oc.disableProjectConfig, "opencode.disableProjectConfig", errors);
      checkBoolean(oc.pure, "opencode.pure", errors);
      checkStringArray(oc.excludeMcps, "opencode.excludeMcps", errors);
    }
  }

  const ret = config.retention;
  if (ret !== undefined) {
    if (!isPlainObject(ret)) {
      errors.push("retention must be an object");
    } else {
      checkInteger(ret.logsDays, "retention.logsDays", errors, { min: 0 });
      checkInteger(ret.maxLogsMb, "retention.maxLogsMb", errors, { min: 0 });
    }
  }

  return { ok: errors.length === 0, errors };
}
