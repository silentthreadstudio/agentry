// exec/steps/reverify — `lane exec reverify <id>`: one fresh verifier for a lane its route closed
// without one.
import * as ledgers from "../../../process/ledger.mjs";
import { verdicts } from "../../rounds.mjs";
import { nestedTrees } from "../admission.mjs";
import { dispatchNext } from "../briefs.mjs";
import { mustLedger, refuse, stepWith } from "../lane.mjs";
import { view } from "../view.mjs";

// A lane closed with no verdict because its route skipped the verifier: one fresh verifier now,
// then the usual rows.
export function run(ctx, id) {
  const { root } = ctx;
  const ledger = mustLedger(root, id);
  if (ledger.state !== "verified")
    refuse(
      `reverify is for a lane closed without a verifier: ${id} is ${ledger.state} (next ${ledger.next})`,
    );
  if (verdicts(ledger).length)
    refuse(
      `reverify is for a lane closed without a verifier: a verifier closed ${id} (${verdicts(ledger).at(-1).verdict})`,
    );
  const res = stepWith(ledger, { type: "reverify" });
  const next = dispatchNext(ctx, res.ledger, res.dispatch);
  next.nested = nestedTrees(root, next);
  ledgers.write(root, next);
  return view(ctx, next, { step: "reverify", nested: next.nested, extra: { why: res.reason } });
}
