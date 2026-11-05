// board contract <task id> [--kind <kind>] [--json] — a task's contract block as one JSON line (plan
// F13 §8; the same result as find-contract.mjs); `--kind` looks up another kind that has contracts. The
// output is always JSON, so `--json` changes nothing. Writes nothing. Exit 0 = found, 1 = not found or
// ambiguous, 2 = usage (a `--kind` the board does not have among them).
//
// run(argv, { root, spec, model }) -> { exit, out }
import { usageError } from "../../cli/help.mjs";
import { findContract } from "../contract.mjs";
import { boardId } from "../ids.mjs";

export const help = {
  usage: "contract <id> [--kind <kind>] [--json]",
  purpose: "A task's contract block (owns, exposes, acceptance) as one JSON line. Writes nothing.",
  args: { "<id>": "a task's id, any case; another kind's with --kind (decision, sprint…)" },
  flags: {
    "--kind <kind>": "another kind that has contracts (default: task)",
    "--json": "accepted for symmetry: the output is always JSON",
  },
  exits: {
    0: "found",
    1: "not found, or ambiguous (two real contracts match)",
    2: "usage, or a --kind the board does not have",
  },
  example: "board contract T-4",
};

export function run(argv, { root, spec, model }) {
  const at = argv.indexOf("--kind");
  const kind = at < 0 ? "task" : argv[at + 1];
  const id = argv.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
  if (!id) return usageError("board contract", "needs an id");
  if (!kind) return usageError("board contract", "--kind needs a kind");
  const known = Object.hasOwn(spec.kinds, kind);
  // The default `task` may be absent (the lookup then falls back to task files); a named kind may not.
  if (at >= 0 && !known)
    return usageError(
      "board contract",
      `unknown kind "${kind}" (kinds: ${Object.keys(spec.kinds).join(", ")})`,
    );
  const result = findContract({
    root,
    spec,
    id: known ? boardId(spec, model, id, kind) : id,
    kind,
    model,
  });
  return { exit: result.status === "found" ? 0 : 1, out: JSON.stringify(result) };
}
