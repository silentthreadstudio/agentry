// board contract <task id> [--kind <kind>] [--json] — a task's contract block as one JSON line (plan
// F13 §8; the same result as find-contract.mjs); `--kind` looks up another kind that has contracts. The
// output is always JSON, so `--json` changes nothing. Writes nothing. Exit 0 = found, 1 = not found or
// ambiguous.
//
// run(argv, { root, spec, model }) -> { exit, out }
import { usageError } from "../../cli/help.mjs";
import { findContract } from "../contract.mjs";

export const help = {
  usage: "contract <id> [--kind <kind>] [--json]",
  purpose: "A task's contract block (owns, exposes, acceptance) as one JSON line. Writes nothing.",
  args: { "<id>": "the item's id, as the board writes it" },
  flags: {
    "--kind <kind>": "another kind that has contracts (default: task)",
    "--json": "accepted for symmetry: the output is always JSON",
  },
  exits: { 0: "found", 1: "not found, or ambiguous (two real contracts match)", 2: "usage" },
  example: "board contract T-4",
};

export function run(argv, { root, spec, model }) {
  const at = argv.indexOf("--kind");
  const kind = at < 0 ? "task" : argv[at + 1];
  const id = argv.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
  if (!id) return usageError("board contract", "needs an id");
  if (!kind) return usageError("board contract", "--kind needs a kind");
  const result = findContract({ root, spec, id, kind, model });
  return { exit: result.status === "found" ? 0 : 1, out: JSON.stringify(result) };
}
