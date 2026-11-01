// merge/recover — what a killed land leaves, dealt with before anything else on the rerun (plan R1b-5).
// A land writes what it is about to do to the ledger before it does it; this step reads that intent
// against main and either finishes what the killed run did or puts main back where the rerun can start.
import { boardFiles } from "../../process/board-diff.mjs";
import { endStrayGate } from "../gate-group.mjs";
import { commitsBetween, filesOf, pickInProgress, subjectOf } from "../land.mjs";
import { afterLand, now, ok, red, save, setMerge, short } from "./lane.mjs";

// The commit on main right after this land's picks, when it is this land's board commit: one commit
// past exactly the picks, touching board files only (the ones the record writes, the carry's). Null
// when main is anything else.
function boardCommitOnMain(lane) {
  const { root, spec, model } = lane;
  const merge = lane.ledger.merge;
  const chain = commitsBetween(root, merge.preHead, "HEAD", { firstParent: true });
  if (chain?.length !== merge.landed.length + 1) return null;
  if (chain.slice(0, -1).join(" ") !== merge.landed.join(" ")) return null;
  const sha = chain.at(-1);
  const files = filesOf(root, sha);
  const board = new Set([...boardFiles(spec, model), ...(merge.carry?.files ?? [])]);
  return files && files.length > 0 && files.every((file) => board.has(file)) ? sha : null;
}

// A run killed while it wrote or committed the board (`step: "recording"`). If its board commit is on
// main, the land is done: the ledger says so now. Otherwise the land is gated again and resumes.
function resumeRecording(lane, rows) {
  const merge = lane.ledger.merge;
  const sha = boardCommitOnMain(lane);
  if (!sha) {
    setMerge(lane, { step: "gated" });
    return null;
  }
  // The carried board writes are in that commit: the ledger lets go of them.
  save(lane, {
    state: "merged",
    merge: { ...merge, carry: undefined, step: "committed", boardCommit: sha, at: now() },
  });
  rows.push(
    ok(
      "recover",
      `a killed run had made the board commit: ${short(sha)} ${subjectOf(lane.root, sha)}`,
      ["the land is done: nothing is picked, gated or committed again"],
    ),
  );
  return { exit: 0, next: afterLand(lane) };
}

/** A killed land leaves its gate's process group, maybe still running; git, maybe in the middle of the
 *  cherry-pick; and a board write or commit the ledger does not know of yet. The rerun deals with each
 *  before anything else. */
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
  if (busy.length > 0) {
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
  if (lane.ledger.merge?.step === "recording") return resumeRecording(lane, rows);
  return null;
}
