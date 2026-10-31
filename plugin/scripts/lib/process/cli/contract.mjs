// board contract <id> [--kind <kind>] — an item's contract block as one JSON line (plan F13 §8; the
// same result as find-contract.mjs). Writes nothing. Exit 0 = found, 1 = not found or ambiguous.
//
// run(argv, { root, spec }) -> { exit, out }
import { findContract } from "../contract.mjs";

export function run(argv, { root, spec }) {
  const at = argv.indexOf("--kind");
  const kind = at < 0 ? "task" : argv[at + 1];
  const id = argv.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
  if (!id || !kind) return { exit: 2, out: "usage: contract <id> [--kind <kind>]" };
  const result = findContract({ root, spec, id, kind });
  return { exit: result.status === "found" ? 0 : 1, out: JSON.stringify(result) };
}
