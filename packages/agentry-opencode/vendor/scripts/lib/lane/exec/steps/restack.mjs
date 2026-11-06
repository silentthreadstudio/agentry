// exec/steps/restack — `lane exec restack <id>`: a stacked lane onto its parent's new tip, or main
// (`restack.mjs`).
import { restackLane } from "../../restack.mjs";
import { nestedTrees } from "../admission.mjs";
import { dispatchNext } from "../briefs.mjs";
import { mustLedger } from "../lane.mjs";
import { view } from "../view.mjs";

// A stacked lane's branch onto its parent's new tip, or main's (its parent landed, or `--main`, the owner's
// call): `restack.mjs` does the guards, the rebase and the record; a hand resolution's check is dispatched here.
export function run(ctx, id) {
  const { root, toMain } = ctx;
  const ledger = mustLedger(root, id);
  const done = restackLane(ctx, ledger, {
    toMain,
    dispatch: (next, plan) => {
      const out = dispatchNext(ctx, next, plan);
      out.nested = nestedTrees(root, out);
      return out;
    },
  });
  if (done.nothing) return view(ctx, ledger, { step: "restack", extra: { restack: done.nothing } });
  return view(ctx, done.ledger, {
    step: "restack",
    nested: nestedTrees(root, done.ledger),
    extra: {
      restacked: done.restacked,
      commits: done.commits,
      ...(done.reason && { why: done.reason }),
    },
  });
}
