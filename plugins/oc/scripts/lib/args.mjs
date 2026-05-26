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
