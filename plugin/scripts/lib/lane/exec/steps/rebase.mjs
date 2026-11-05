// exec/steps/rebase — `lane exec rebase <id>`: a verified lane's branch rebased onto main by its
// builder.
import * as ledgers from "../../../process/ledger.mjs";
import { gateOf } from "../../../process/spec/workflow.mjs";
import { now } from "../../fmt.mjs";
import { isAncestor } from "../../land.mjs";
import { expects } from "../../rounds.mjs";
import { restackLine, stackOf } from "../../stack.mjs";
import { nestedTrees, refuseAtWriterCap } from "../admission.mjs";
import { buildTier, dispatchNext } from "../briefs.mjs";
import { headOf } from "../guard/snapshot.mjs";
import { mustLedger, refuse, stepWith } from "../lane.mjs";
import { finishRebase } from "../rebasing.mjs";
import { view } from "../view.mjs";

// A verified lane whose branch must be rebased onto main (a land conflict, or a branch moved past where it
// closed). A land that stopped on a conflict put nothing on main, so its lane is still the verified one.
// `{ fromBase, fromTip }` goes into `rebases[]` before the dispatch: a rerun that finds the last entry
// unfinished reuses it, and one whose rebase round is out prints it again. A branch that already sits on
// main past `closedTip` is recorded as rebased, with no builder round.
export function run(ctx, id) {
  const { root, spec } = ctx;
  const ledger = mustLedger(root, id);
  const out = ledger.rounds.at(-1);
  if (out?.step === "rebase" && expects(ledger) === "report")
    return view(ctx, ledger, { step: "rebase", extra: { why: "the rebase round is out already" } });
  const conflicted =
    ledger.state === "merging" &&
    ["conflict", "rolled-back"].includes(ledger.merge?.step) &&
    ledger.merge?.stateBefore === "verified";
  if (ledger.state !== "verified" && !conflicted)
    refuse(`rebase is for a verified lane: ${id} is ${ledger.state} (next ${ledger.next})`);
  // A stacked lane moves with its parent until the parent lands (R1d-14 N2).
  const stack = stackOf(root, ledger, ledgers.list(root));
  if (stack.on && stack.state !== "merged")
    refuse(
      `${id} is stacked on ${stack.on}: restack it (${restackLine(root, id)}), never rebase it onto main`,
    );
  const tip = headOf(root, ledger.branch);
  const main = headOf(root, ledger.mainBranch);
  const moved =
    Boolean(ledger.closedTip) && tip !== ledger.closedTip && isAncestor(root, main, tip);
  if (!moved) refuseAtWriterCap(root, spec);
  let next = {
    ...structuredClone(ledger),
    state: "verified",
    ...(conflicted && { next: "merge" }),
  };
  // `mainHead`: main as the rebase was asked for, the furthest the guard's start may move to (N7).
  if (next.rebases?.at(-1)?.toTip === undefined && next.rebases?.length) {
    // A killed run's entry: reused as it is.
    next.rebases.at(-1).mainHead ??= headOf(root);
  } else {
    next.rebases = [
      ...(next.rebases ?? []),
      {
        fromBase: ledger.base,
        fromTip: moved ? ledger.closedTip : tip,
        mainHead: headOf(root),
        at: now(),
      },
    ];
    ledgers.write(root, next);
  }
  let res;
  if (moved) {
    const changed = finishRebase(root, next, tip);
    res = stepWith(next, {
      type: "rebased",
      tip,
      changed,
      gate: gateOf(spec) !== null,
      tier: buildTier(ctx, next),
    });
  } else res = stepWith(next, { type: "rebase" });
  next = dispatchNext(ctx, res.ledger, res.dispatch);
  next.nested = nestedTrees(root, next);
  ledgers.write(root, next);
  return view(ctx, next, {
    step: "rebase",
    nested: next.nested,
    extra: {
      ...(moved && { rangeDiff: next.rebases.at(-1).rangeDiff }),
      ...(res.reason && { why: res.reason }),
    },
  });
}
