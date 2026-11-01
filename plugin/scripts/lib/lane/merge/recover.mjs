// merge/recover — what a killed land leaves, dealt with before anything else on the rerun (plan R1b-5).
// A land writes what it is about to do to the ledger before it does it; this step reads that intent
// against main and either finishes what the killed run did or puts main back where the rerun can start.
import { endStrayGate } from "../gate-group.mjs";
import { pickInProgress } from "../land.mjs";
import { ok, red, setMerge, short } from "./lane.mjs";

/** A killed land leaves two things a rerun deals with before anything else: its gate's process group,
 *  maybe still running, and git, maybe in the middle of the cherry-pick. */
export function recoverStep(lane, rows) {
  const { root, ledger } = lane;
  const merge = ledger.merge;
  if (merge?.gateRun) {
    const res = endStrayGate(merge.gateRun);
    if (!res.ok) {
      rows.push(red("recover", `the gate a killed run started is still running: ${res.reason}`));
      return {
        exit: 1,
        keepCarry: true,
        next: `stop process group ${res.pgid} (kill -KILL -- -${res.pgid}), then land again`,
      };
    }
    setMerge(lane, { gateRun: undefined, ...(merge.step === "gating" && { step: "landed" }) });
    if (res.killed)
      rows.push(
        ok("recover", `stopped the gate a killed run left running (process group ${res.pgid})`),
      );
  }
  const busy = pickInProgress(root);
  if (busy.length === 0) return null;
  const where = merge?.preHead ? ` (the land started from ${short(merge.preHead)})` : "";
  rows.push(
    red(
      "recover",
      `git is in the middle of a cherry-pick in the main checkout${where}: a killed land leaves one`,
      busy.map((b) => b.path),
    ),
  );
  return {
    exit: 1,
    keepCarry: true,
    next: `in ${root}: git cherry-pick --abort (it puts ${ledger.mainBranch} back where the pick started), then land again`,
  };
}
