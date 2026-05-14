// Zero-dep CLI argument parser.
//
// Supports:
//   --flag                       -> boolean true
//   --no-flag                    -> boolean false (for flags listed as boolean)
//   --key value                  -> string
//   --key=value                  -> string
//   --key a,b,c                  -> string (caller splits if it wants array)
//   --                           -> end of options; remaining tokens go to `rest`
//   positional                   -> appended to `positionals`
//
// `spec` is an object describing known flags:
//   { read-only: { type: "boolean" },
//     model:     { type: "string" },
//     include:   { type: "string", alias: "i" } }
//
// Unknown flags raise an error. Boolean flags accept no value.

export function parseArgs(argv, spec = {}) {
  const positionals = [];
  const flags = {};
  const rest = [];
  let afterDash = false;

  // Build alias lookup.
  const byName = { ...spec };
  const aliasToName = {};
  for (const [name, def] of Object.entries(spec)) {
    if (def.alias) aliasToName[def.alias] = name;
  }
  const findFlag = (key) => {
    if (byName[key]) return { name: key, def: byName[key] };
    if (aliasToName[key]) return { name: aliasToName[key], def: byName[aliasToName[key]] };
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (afterDash) { rest.push(token); continue; }
    if (token === "--") { afterDash = true; continue; }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      let key = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      let value = eq >= 0 ? token.slice(eq + 1) : undefined;
      let negated = false;
      if (key.startsWith("no-")) { negated = true; key = key.slice(3); }
      const found = findFlag(key);
      if (!found) throw new Error(`unknown flag: --${negated ? "no-" : ""}${key}`);
      const { name, def } = found;
      if (def.type === "boolean") {
        if (value !== undefined) {
          flags[name] = value === "true" || value === "1";
        } else {
          flags[name] = !negated;
        }
        continue;
      }
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new Error(`--${key} expects a value`);
      }
      flags[name] = value;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      // single-char alias chain (only "value" types here; we don't combine)
      const key = token.slice(1);
      const found = findFlag(key);
      if (!found) { positionals.push(token); continue; }
      const { name, def } = found;
      if (def.type === "boolean") { flags[name] = true; continue; }
      const value = argv[++i];
      if (value === undefined) throw new Error(`-${key} expects a value`);
      flags[name] = value;
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals, rest };
}

export function splitCsv(s) {
  if (typeof s !== "string" || s === "") return [];
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

// Split a raw argument string into argv tokens, POSIX-shell-style but without
// any expansion (no globs, no variables, no command substitution).
//
//   foo bar         -> ["foo", "bar"]
//   "hello world"   -> ["hello world"]
//   foo\ bar        -> ["foo bar"]
//
// We use this when the caller (a slash command) hands us the user's prompt as
// one big string via stdin to avoid shell interpolation. Anything in the user's
// text lands in argv as plain data — no shell parse step.
export function splitRawArgumentString(raw) {
  const s = String(raw ?? "");
  const tokens = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  const push = () => {
    if (hasContent || buf !== "") {
      tokens.push(buf);
      buf = "";
      hasContent = false;
    }
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inSingle) {
      if (ch === "'") { inSingle = false; continue; }
      buf += ch; hasContent = true;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < s.length) {
        const next = s[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n") {
          buf += next; i++; hasContent = true;
          continue;
        }
        buf += ch; hasContent = true;
        continue;
      }
      if (ch === '"') { inDouble = false; continue; }
      buf += ch; hasContent = true;
      continue;
    }

    // Outside quotes.
    if (ch === "\\" && i + 1 < s.length) {
      buf += s[i + 1]; i++; hasContent = true;
      continue;
    }
    if (ch === "'") { inSingle = true; hasContent = true; continue; }
    if (ch === '"') { inDouble = true; hasContent = true; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    buf += ch; hasContent = true;
  }
  push();
  return tokens;
}
