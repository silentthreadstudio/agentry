// board next-id <kind> — the next free id from the kind's `create.id` pattern (plan F13 §2.4; see
// `ids.mjs`). Exit 2 when the kind asks for its ids (`"ask"`) or the pattern needs more than a number.
// Writes nothing.
//
// run(argv, { spec, model }) -> { exit, out }
import { nextId } from "../ids.mjs";
import { own } from "../spec.mjs";

export const usage = "next-id <kind>";
export const flags = {};

export function run(argv, { spec, model }) {
  const name = argv.find((a) => !a.startsWith("--"));
  const kind = own(spec.kinds, name);
  if (!kind)
    return { exit: 2, out: `usage: ${usage} (kinds: ${Object.keys(spec.kinds).join(", ")})` };
  const { id, error } = nextId(name, kind, model);
  return error ? { exit: 2, out: error } : { exit: 0, out: id };
}
