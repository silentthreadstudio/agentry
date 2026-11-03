// board contract <task id> [--kind <kind>] [--json] — a task's contract block as one JSON line (plan
// F13 §8; the same result as find-contract.mjs); `--kind` looks up another kind that has contracts. The
// output is always JSON, so `--json` changes nothing. Writes nothing. Exit 0 = found, 1 = not found or
// ambiguous.
//
// run(argv, { root, spec, model }) -> { exit, out }
import { findContract } from "../contract.mjs";

export const usage = "contract <task id> [--kind <kind>] [--json]";
export const flags = { "--kind": true, "--json": false };

export function run(argv, { root, spec, model }) {
  const at = argv.indexOf("--kind");
  const kind = at < 0 ? "task" : argv[at + 1];
  const id = argv.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
  if (!id || !kind) return { exit: 2, out: `usage: ${usage}` };
  const result = findContract({ root, spec, id, kind, model });
  return { exit: result.status === "found" ? 0 : 1, out: JSON.stringify(result) };
}
