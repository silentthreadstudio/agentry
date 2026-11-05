// args — a verb's options, from its field list. A field is `{ kind, doc, required?, min?, max?, options? }`
// under its camelCase name (`usedMemories`); its flag is the kebab-case `--used-memories`, the name the
// MCP tool took the argument by. Kinds: "string"; "int" and "number" (with min, max); "enum" (options);
// "list" (the flag repeated, one item each, taken as given: no comma splitting). Every verb also takes
// `--json`. A field may name its placeholder in the help with `value` (`"<id>"`). The router has already refused an option no field names and spelled `--flag=value` as
// `--flag value`; what is left to check here is the values.
//
// usage(verb, fields) -> the `help.usage` line   flagHelp(fields) -> the `help.flags` table
// parse(fields, argv) -> { args, json } | { error }
// `args` carries only the fields that were given (a list absent stays absent).

const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const VALUE = { string: "<text>", int: "<n>", number: "<n>", list: "<id>" };

const placeholder = (field) =>
  field.kind === "enum" ? `<${field.options.join("|")}>` : (field.value ?? VALUE[field.kind]);

/** The `help.usage` line of a verb: its required flags, then the optional ones in brackets. */
export function usage(verb, fields) {
  const flags = Object.entries(fields).map(([name, f]) => {
    const flag = `--${kebab(name)} ${placeholder(f)}`;
    return f.required ? flag : `[${flag}]`;
  });
  return [verb, ...flags, "[--json]"].join(" ");
}

/** The `help.flags` table of a verb: one row per field, then `--json`. */
export function flagHelp(fields) {
  return {
    ...Object.fromEntries(
      Object.entries(fields).map(([name, f]) => [
        `--${kebab(name)} ${placeholder(f)}`,
        `${f.required ? "(required) " : ""}${f.doc}${f.kind === "list" ? " (repeat for more)" : ""}`,
      ]),
    ),
    "--json": "print the result as one JSON object",
  };
}

// The number a value spells, or an error saying what it should be.
function number(flag, text, field) {
  const n = text.trim() === "" ? Number.NaN : Number(text);
  const whole = field.kind === "int";
  if (!Number.isFinite(n) || (whole && !Number.isInteger(n)))
    return { error: `${flag} must be ${whole ? "a whole number" : "a number"}, not "${text}"` };
  if (field.min !== undefined && n < field.min)
    return { error: `${flag} must be at least ${field.min}` };
  if (field.max !== undefined && n > field.max)
    return { error: `${flag} must be at most ${field.max}` };
  return { value: n };
}

export function parse(fields, argv) {
  const byFlag = new Map(
    Object.entries(fields).map(([name, f]) => [`--${kebab(name)}`, [name, f]]),
  );
  const args = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") {
      json = true;
      continue;
    }
    const entry = byFlag.get(flag);
    if (!entry) return { error: `unexpected argument "${flag}"` };
    const [name, field] = entry;
    const text = argv[++i];
    if (text === undefined) return { error: `${flag} needs a value` };
    if (field.kind === "list") {
      args[name] = [...(args[name] ?? []), text];
      continue;
    }
    if (name in args) return { error: `${flag} was given twice` };
    if (field.kind === "enum") {
      if (!field.options.includes(text))
        return { error: `${flag} must be one of ${field.options.join(", ")}, not "${text}"` };
      args[name] = text;
    } else if (field.kind === "string") args[name] = text;
    else {
      const n = number(flag, text, field);
      if (n.error) return n;
      args[name] = n.value;
    }
  }
  const missing = Object.entries(fields).find(([name, f]) => f.required && !(name in args));
  if (missing) return { error: `--${kebab(missing[0])} is required` };
  return { args, json };
}
