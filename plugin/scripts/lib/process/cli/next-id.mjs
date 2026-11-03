// board next-id <kind> — the next free id from the kind's `create.id` pattern (plan F13 §2.4; see
// `ids.mjs`). Exit 2 when the kind asks for its ids (`"ask"`) or the pattern needs more than a number.
// Writes nothing.
//
// run(argv, { spec, model }) -> { exit, out }
import { refuse, usageError } from "../../cli/help.mjs";
import { nextId } from "../ids.mjs";
import { own } from "../spec.mjs";

export const help = {
  usage: "next-id <kind> [--json]",
  purpose: "The next free id of a kind, from its create.id pattern. Writes nothing.",
  args: { "<kind>": "a kind the process file knows (task, sprint, decision…)" },
  flags: { "--json": "print { kind, id } as one JSON object" },
  exits: { 0: "printed", 2: "usage, or the kind's ids are chosen by hand" },
  example: "board next-id task",
};

export function run(argv, { spec, model }) {
  const name = argv.find((a) => !a.startsWith("--"));
  const kind = own(spec.kinds, name);
  if (!kind)
    return usageError(
      "board next-id",
      `${name ? `unknown kind "${name}"` : "needs a kind"} (kinds: ${Object.keys(spec.kinds).join(", ")})`,
    );
  const { id, error } = nextId(name, kind, model);
  if (error) return refuse("board next-id", error);
  return { exit: 0, out: argv.includes("--json") ? JSON.stringify({ kind: name, id }) : id };
}
