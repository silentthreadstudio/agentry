// merge/status — `lane merge --status`: is a land running. The ledger in state `merging` before its board
// commit names the land (`process/ledger.mjs`'s `landInProgress`), and the process it recorded says whether
// that land still runs; the answer is the same one a refused writer is told.
import { landInProgress } from "../../process/ledger.mjs";
import { clock } from "../exec-view.mjs";

const ALIVE = { true: "alive", false: "dead", null: "unknown" };

/** `{ exit: 0, out }`: `landing <id> · step <s> · since <t> · alive|dead` (`unknown` for a land whose record
 *  names no process: one an older version began) or `no land running`; `--json` prints `{ landing }`, the
 *  land as `landInProgress` answers or null. */
export function statusMode(root, { json }) {
  const landing = landInProgress(root);
  if (json) return { exit: 0, out: JSON.stringify({ landing }) };
  if (!landing) return { exit: 0, out: "no land running" };
  const { id, step, since, alive } = landing;
  return {
    exit: 0,
    out: `landing ${id} · step ${step} · since ${clock(since)} · ${ALIVE[alive]}`,
  };
}
