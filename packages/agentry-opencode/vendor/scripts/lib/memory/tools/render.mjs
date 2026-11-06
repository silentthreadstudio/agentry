// render — a result as the text a verb prints. Default: `key: value` lines; nested objects as
// `a.b: value`, lists of objects as `a[0].b: value`, lists of scalars on one line joined by ", ", an
// empty list or object as `none`; a value with a line break is written as a JSON string so one value is
// always one line. `--json` prints the result as one JSON object, the shape the MCP tools returned.
import { say } from "../../cli/help.mjs";

const scalar = (v) => v === null || typeof v !== "object";
const show = (v) => (typeof v === "string" && /[\n\r]/.test(v) ? JSON.stringify(v) : String(v));

function flatten(path, value, out) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    if (value.every(scalar))
      out.push(`${path}: ${value.length ? value.map(show).join(", ") : "none"}`);
    else value.forEach((item, i) => flatten(`${path}[${i}]`, item, out));
  } else if (typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) out.push(`${path}: none`);
    for (const key of keys) flatten(path ? `${path}.${key}` : key, value[key], out);
  } else out.push(`${path}: ${show(value)}`);
}

/** `data` as `key: value` lines. */
export function text(data) {
  const out = [];
  flatten("", data, out);
  return out.join("\n");
}

/** A refusal as the error line: `✗ mem recover: not-found: <why> → <fix>`. */
export const refusal = (verb, error) =>
  say(`mem ${verb}`, `${error.code}: ${error.why}`, error.fix);
