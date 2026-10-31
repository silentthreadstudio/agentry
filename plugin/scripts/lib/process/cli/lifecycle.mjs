// board lifecycle <event> <id> [--verdict v] [--sha s]… [--summary t] [--json] — apply one harness
// event to a board item through `lifecycle.mjs` (plan R1b §3.1): the status, verdict, commit cell and
// handoff line the process file's `lifecycle` maps it to, in one write or none.
//
// run(argv, { root, spec, model }) -> { exit, out }   exit 0 = written (or every step skipped),
// 2 = usage or refusal (nothing written)
import { EVENTS, applyEvent } from "../lifecycle.mjs";
import { WriteError } from "../write.mjs";

export const usage = `lifecycle <${EVENTS.join("|")}> <id> [--verdict <v>] [--sha <sha>]… [--summary <text>] [--json]`;
export const flags = { "--verdict": true, "--sha": true, "--summary": true, "--json": false };
const fail = (out) => ({ exit: 2, out });

// argv → { event, id, data, json } or { error }. `--sha` may repeat (first landed first); the others
// are given once.
function parse(argv) {
  const words = [];
  const data = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (!Object.hasOwn(flags, arg)) words.push(arg);
    else {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
      const key = arg.slice(2);
      if (key === "sha") data.shas = [...(data.shas ?? []), value];
      else if (Object.hasOwn(data, key)) return { error: `${arg} is given twice` };
      else data[key] = value;
    }
  }
  if (words.length !== 2) return { error: `usage: ${usage}` };
  return { event: words[0], id: words[1], data, json };
}

export function run(argv, { root, spec, model }) {
  const { event, id, data, json, error } = parse(argv);
  if (error) return fail(error);
  let result;
  try {
    result = applyEvent({ root, spec, model, event, id, data });
  } catch (e) {
    if (e instanceof WriteError) return fail(`lifecycle ${event} ${id}: ${e.message}`);
    throw e;
  }
  if (json) return { exit: 0, out: JSON.stringify({ event, id, ...result }) };
  const lines = [
    `lifecycle ${event} ${id}: ${result.writes.length} written, ${result.skipped.length} skipped`,
    ...result.writes.map((w) => `  wrote ${w.what} (${w.file})`),
    ...result.skipped.map((s) => `  skipped ${s.what}: ${s.why}`),
  ];
  return { exit: 0, out: lines.join("\n") };
}
