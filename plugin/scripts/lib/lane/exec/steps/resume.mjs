// exec/steps/resume — `lane exec resume <id>`: the owner's answer to a hold, then the next round.
import * as ledgers from "../../../process/ledger.mjs";
import { gateOf } from "../../../process/spec/workflow.mjs";
import { answerLabel } from "../../exec-view.mjs";
import { redoRefusal, skipsVerifier } from "../../rounds.mjs";
import { nestedTrees, refuseAtWriterCap } from "../admission.mjs";
import { writeBuilt } from "../board.mjs";
import { buildTier, dispatchNext } from "../briefs.mjs";
import { mainGuard } from "../guard/main-guard.mjs";
import { headOf } from "../guard/snapshot.mjs";
import {
  isFlagged,
  isVerifiedPark,
  laneLine,
  mustLedger,
  now,
  refuse,
  short,
  stepWith,
} from "../lane.mjs";
import { answerOf, stepCount, view } from "../view.mjs";

// The owner's answer to a hold: recorded with its time, then the held round's builder carries on (the
// next run, the same run with --redo, or the same round after a hold during it), or after the last step
// the verifier (or the gate) is next and built is written. Main must be as the lane left it.
export function run(ctx, id) {
  const { root, spec, note, redo, fresh, same } = ctx;
  const ledger = mustLedger(root, id);
  if (ledger.state !== "held")
    refuse(`the lane is not held (state ${ledger.state}, next ${ledger.next})`);
  if (!note) refuse(`resume needs --note "<the owner's words>"`);
  if (redo && ledger.hold?.when !== "after") refuse(redoRefusal(ledger.hold));
  // A parked verified lane, or one the notes cap holds: no builder is out or sent, and built is written.
  const parked = isVerifiedPark(ledger) || ledger.hold?.when === "verdict";
  // Main may have moved by commits that touch none of the lane's files (field 68): the guard's own rule.
  const main = parked ? null : mainGuard(ctx, ledger, ledgers.list(root));
  if (main?.touched)
    refuse(
      main.overlap
        ? `main changed while ${id} was held: ${main.touched} → ${laneLine(root, "restart", id, " --carry")}`
        : `main changed while ${id} was held: ${main.touched}: undo that, then resume`,
    );
  const moved = main?.moved
    ? `main moved by ${main.moved} commits, none touching this lane's files: resuming on base ${short(ledger.base)}`
    : null;
  const flagged = isFlagged(ctx, ledger);
  const res = stepWith(ledger, {
    type: "resume",
    note,
    redo,
    same,
    at: now(),
    skipVerify: skipsVerifier(ledger.route, flagged),
    tip: headOf(root, ledger.branch),
    gate: gateOf(spec) !== null,
    tier: buildTier(ctx, ledger),
  });
  if (res.dispatch?.role === "build") refuseAtWriterCap(root, spec);
  let next = res.ledger;
  if (ledger.route) next.route = { ...ledger.route, flagged };
  next.nested = nestedTrees(root, next);
  // A verified lane (or one past its verifier) wrote built long ago: its resume writes no board cell.
  const board = parked ? null : writeBuilt(ctx, next, res);
  let dispatch = res.dispatch;
  if (dispatch && fresh) {
    const { agent, ...rest } = dispatch;
    dispatch = { ...rest, mode: "fresh" };
  }
  next = dispatchNext(ctx, next, dispatch);
  ledgers.write(root, next);
  const answer = next.holds.at(-1);
  return view(ctx, next, {
    step: "resume",
    nested: next.nested,
    lead: { [answerLabel(answer)]: answerOf(answer, stepCount(next)), ...(moved && { moved }) },
    extra: { ...(res.reason && { why: res.reason }), ...(board && { board }) },
  });
}
