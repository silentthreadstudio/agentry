// board lifecycle <event> <id> [--verdict v] [--sha s]… [--summary t] [--apply] [--json] — apply one
// harness event to a board item through `lifecycle.mjs` (plan R1b §3.1): the status, verdict, commit cell
// and handoff line the process file's `lifecycle` maps it to, in one write or none. Without `--apply` it
// runs the same edits and refusals and writes nothing (A39).
//
// run(argv, { root, spec, model }) -> { exit, out }   exit 0 = written, previewed or every step skipped,
// 2 = usage or refusal (nothing written)
import { PREVIEW, flagsOf, refuse, usageError } from "../../cli/help.mjs";
import { boardId } from "../ids.mjs";
import { EVENTS, applyEvent } from "../lifecycle.mjs";
import { WriteError } from "../write.mjs";

export const help = {
  usage: `lifecycle <${EVENTS.join("|")}> <id> [--verdict <v>] [--sha <sha>]… [--summary <text>] [--apply] [--json]`,
  purpose: "Apply one harness event to a board item: the status, verdict, commit and handoff line.",
  args: {
    "<event>": EVENTS.join(", "),
    "<id>": "the item's id (any case), of the process file's lifecycle.kind",
  },
  flags: {
    "--verdict <v>": "the verdict, for the verdict event (PASS, PASS WITH NOTES, FAIL)",
    "--sha <sha>": "a landed commit, for merged; repeat it, first landed first",
    "--summary <text>": "the handoff text, for merged",
    "--apply": "write it (without: say what it would write, and write nothing)",
    "--json": "print the writes and the skipped steps as one JSON object",
  },
  exits: {
    0: "written, previewed, or every step skipped",
    2: "usage, or refused (nothing written)",
  },
  example: "board lifecycle verdict T-4 --verdict PASS --apply",
};
const flags = flagsOf(help);
const SWITCHES = ["--json", "--apply"];
const what = "board lifecycle";

// argv → { event, id, data, json, write } or { error }. `--sha` may repeat (first landed first); the
// others are given once.
function parse(argv) {
  const words = [];
  const data = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCHES.includes(arg)) continue;
    if (!Object.hasOwn(flags, arg)) words.push(arg);
    else {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
      const key = arg.slice(2);
      if (key === "sha") data.shas = [...(data.shas ?? []), value];
      else if (Object.hasOwn(data, key)) return { error: `${arg} is given twice` };
      else data[key] = value;
    }
  }
  if (words.length !== 2) return { error: "needs <event> <id>" };
  const [json, write] = SWITCHES.map((s) => argv.includes(s));
  return { event: words[0], id: words[1], data, json, write };
}

export function run(argv, { root, spec, model }) {
  const { event, id: typed, data, json, write, error } = parse(argv);
  if (error) return usageError(what, error);
  const id = spec.lifecycle ? boardId(spec, model, typed, spec.lifecycle.kind) : typed;
  let result;
  try {
    result = applyEvent({ root, spec, model, event, id, data, preview: !write });
  } catch (e) {
    if (e instanceof WriteError) return refuse(`${what} ${event} ${id}`, e.message);
    throw e;
  }
  if (json) return { exit: 0, out: JSON.stringify({ event, id, applied: write, ...result }) };
  const [done, wrote] = write ? ["written", "wrote"] : ["would be written", "would write"];
  const lines = [
    `lifecycle ${event} ${id}: ${result.writes.length} ${done}, ${result.skipped.length} skipped`,
    ...result.writes.map((w) => `  ${wrote} ${w.what} (${w.file})`),
    ...result.skipped.map((s) => `  skipped ${s.what}: ${s.why}`),
    ...(write || !result.writes.length ? [] : [PREVIEW]),
  ];
  return { exit: 0, out: lines.join("\n") };
}
