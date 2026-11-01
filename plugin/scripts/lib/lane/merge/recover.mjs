// merge/recover — what a killed land leaves, dealt with before anything else on the rerun (plan R1b-5).
// A land writes what it is about to do to the ledger before it does it; this step reads that intent
// against main and either finishes what the killed run did or puts main back where the rerun can start.
import { boardFiles } from "../../process/board-diff.mjs";
import { endStrayGate } from "../gate-group.mjs";
import {
  commitsBetween,
  filesOf,
  notEdits,
  pickInProgress,
  restoreFiles,
  statusEntries,
  subjectOf,
} from "../land.mjs";
import { afterLand, now, ok, red, save, setMerge, short } from "./lane.mjs";

// The files the record writes to: the board's, and the carry's.
const boardSet = ({ spec, model, ledger }) =>
  new Set([...boardFiles(spec, model), ...(ledger.merge.carry?.files ?? [])]);

// The commit on main right after this land's picks, when it is this land's board commit: one commit
// past exactly the picks, touching board files only. Null when main is anything else.
function boardCommitOnMain(lane, chain) {
  const merge = lane.ledger.merge;
  if (chain.length !== merge.landed.length + 1) return null;
  if (chain.slice(0, -1).join(" ") !== merge.landed.join(" ")) return null;
  const sha = chain.at(-1);
  const files = filesOf(lane.root, sha);
  const board = boardSet(lane);
  return files && files.length > 0 && files.every((file) => board.has(file)) ? sha : null;
}

// The board files main holds plain edits of (staged or not): the board writes a killed run left.
function boardWritesLeft(lane) {
  const entries = statusEntries(lane.root) ?? [];
  const other = new Set(
    notEdits(
      entries,
      entries.map((entry) => entry.slice(3)),
    ),
  );
  const board = boardSet(lane);
  return entries
    .filter((entry) => !other.has(entry))
    .map((entry) => entry.slice(3))
    .filter((file) => board.has(file));
}

// A run killed while it wrote or committed the board (`step: "recording"`). Its board commit on main:
// the land is done, and the ledger says so now. Main still at the picks: whatever board writes it
// left (the carry put back, the merged write, staged or not) are taken back, and the land resumes
// from its green gate. Main anything else: the land step says main has moved.
function resumeRecording(lane, rows) {
  const { root } = lane;
  const merge = lane.ledger.merge;
  const chain = commitsBetween(root, merge.preHead, "HEAD", { firstParent: true }) ?? [];
  const sha = boardCommitOnMain(lane, chain);
  if (!sha) {
    if (chain.join(" ") !== merge.landed.join(" ")) return null;
    const left = boardWritesLeft(lane);
    if (left.length > 0) {
      const back = restoreFiles(root, left);
      if (!back.ok) {
        rows.push(red("recover", `cannot take back a killed run's board writes: ${back.reason}`));
        return { exit: 1, keepCarry: true, next: `show the owner git status in ${root}` };
      }
      rows.push(
        ok("recover", "took back the board writes a killed run left uncommitted", [
          `${left.join(", ")}: back at HEAD; the land writes them again`,
        ]),
      );
    }
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
