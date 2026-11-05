// exec/cut/recover — a cut a kill left mid-land, rolled back by the cut itself on `--apply`: only what is
// the cut's own by identity (its kept commit, its board commit, its board cells) comes off main; anything
// else on main refuses with nothing changed.
import { cellText, diffBoard } from "../../../process/board-diff.mjs";
import { applyEvent } from "../../../process/lifecycle.mjs";
import { readProcess } from "../../../process/read.mjs";
import { own } from "../../../process/spec/shape.mjs";
import { lifecycleOf } from "../../../process/spec/workflow.mjs";
import { headBoard, workingBoard } from "../../carry-io.mjs";
import { short } from "../../fmt.mjs";
import { endStrayGate } from "../../gate-group.mjs";
import {
  abortPick,
  commitOf,
  commitsBetween,
  filesOf,
  isAncestor,
  pickInProgress,
  restoreFiles,
  statusEntries,
  subjectOf,
  treeOf,
} from "../../land.mjs";
import { giveBack } from "../../merge/carry.mjs";
import { save } from "../../merge/lane.mjs";
import { git } from "../../worktree.mjs";
import { refuse, stop } from "../lane.mjs";
import { first } from "./land.mjs";
import { listed } from "./plan.mjs";

// A commit's first parent, or null.
const parentOf = (root, sha) => commitOf(root, `${sha}^`);

/** Is `sha` (a commit on main since the stuck cut's `preHead`) one the cut made, by identity, never by its
 *  subject: the kept commit the ledger recorded, or (a kill before the record) one on `preHead` whose tree
 *  is the planned kept commit's; the board commit whose parent and files' blobs are the ones recorded
 *  before it was made (`boardPlan`). */
function cutsOwn(root, merge, sha) {
  if ((merge.landed ?? []).includes(sha)) return true;
  const [planned] = merge.planned ?? [];
  const parent = parentOf(root, sha);
  if (planned && parent === merge.preHead && treeOf(root, sha) === treeOf(root, planned))
    return true;
  const board = merge.boardPlan;
  if (!board || parent !== board.parent) return false;
  const want = Object.keys(board.files ?? {});
  const files = filesOf(root, sha) ?? [];
  if (files.length !== want.length || !want.every((f) => files.includes(f))) return false;
  return want.every(
    (f) =>
      git(root, ["rev-parse", "--verify", "--quiet", `${sha}:${f}`]).stdout.trim() ===
      board.files[f],
  );
}

/** The board files of `files` (dirty on main) holding anything the stuck cut did not write: every
 *  difference from HEAD must be a cell the cut itself set (a carried cell, a recorded write's cell, or
 *  its own `cut` word), each at the text the cut gave it. A change that is no cell (a line by hand, an
 *  added row) is never the cut's. */
function strangeBoards(ctx, merge, files) {
  const { root, spec, id, kind } = ctx;
  if (!files.length) return [];
  const after = workingBoard(root, spec);
  const before = headBoard(root, spec, after.model);
  const diff = diffBoard({ spec, before, after, files });
  const life = lifecycleOf(spec, kind);
  const field = own(life?.write, "status");
  const column = field && own(own(spec.kinds[life.kind], "fields"), field)?.column;
  const owned = [
    ...(merge.carry?.cells ?? []),
    ...(merge.writes?.cells ?? []),
    ...(column ? [{ kind: life.kind, id, column, to: own(life.on, "cut") }] : []),
  ];
  const text = (v) => String(v ?? "").trim();
  const mine = (c) => {
    const now = text(cellText(spec, after, c));
    return owned.some(
      (o) => o.kind === c.kind && o.id === c.id && o.column === c.column && text(o.to) === now,
    );
  };
  const bad = new Set(diff.other.map((o) => o.file));
  for (const c of diff.cells) if (!mine(c)) bad.add(c.file);
  return files.filter((f) => bad.has(f));
}

/** A cut a kill left mid-land (`merging`, `merge.cut`), rolled back by the cut itself: the gate it left
 *  running stopped, a cherry-pick in progress aborted, main reset to `preHead` with `git reset --keep`
 *  when its first-parent commits since are only the cut's own (`cutsOwn`), board files the cut was
 *  writing back to HEAD only when every difference is its own (`strangeBoards`), the set-aside writes put
 *  back (`giveBack`), the lane's state before the cut restored and `merge` cleared. Always a stop: the
 *  owner runs the cut again. Refuses (nothing changed) on anything else on main. */
export function recoverCut(ctx, ledger) {
  const { root, spec, id } = ctx;
  const merge = ledger.merge;
  const main = ledger.mainBranch;
  if (merge.gateRun) {
    const ended = endStrayGate(merge.gateRun);
    if (!ended.ok)
      refuse(
        `the stuck cut's gate is still running: ${ended.reason} → kill -KILL -- -${ended.pgid}, then cut again`,
      );
  }
  if (pickInProgress(root).length) {
    const aborted = abortPick(root);
    if (!aborted.ok) refuse(`git is mid-pick in ${root}: ${aborted.reason}`);
  }
  const preHead = merge.preHead;
  const chain = isAncestor(root, preHead, "HEAD")
    ? commitsBetween(root, preHead, "HEAD", { firstParent: true })
    : null;
  if (!chain)
    refuse(
      `${main} no longer holds ${short(preHead)}, where the stuck cut began: put it back in ${main}'s history, then run exec cut again`,
    );
  const others = chain.filter((sha) => !cutsOwn(root, merge, sha));
  if (others.length)
    refuse(
      `${main} has commits past ${short(preHead)} that are not the stuck cut's: ${listed(others.map((sha) => `${short(sha)} ${subjectOf(root, sha)}`))}; nothing rolled back`,
    );
  // Once the board commit holds the set-aside writes, the ledger lets go of them (`cutBoard`): a reset
  // then would lose them.
  if (merge.cutBoard)
    refuse(
      `the stuck cut's board commit ${short(merge.cutBoard)} is on ${main} and holds the writes it set aside: nothing rolled back; close its ledger and remove its worktree by hand`,
    );
  const writing = [...new Set([...(merge.carry?.files ?? []), ...(merge.writes?.files ?? [])])];
  const event = spec.lifecycle
    ? applyEvent({ ...ctx, model: readProcess({ root, spec }), event: "cut", preview: true })
    : { writes: [] };
  const boards = new Set([...writing, ...event.writes.map((w) => w.file)]);
  const dirty = (statusEntries(root) ?? ["?? git status failed"]).map((e) => e.slice(3));
  const stray = dirty.filter((f) => !boards.has(f));
  if (stray.length)
    refuse(`${main} has changes the stuck cut did not make: ${listed(stray)}; nothing rolled back`);
  const strange = strangeBoards(ctx, merge, dirty);
  if (strange.length)
    refuse(
      `${listed(strange)} has writes made after the cut stopped: commit or set them aside, then run exec cut again`,
    );
  const restored = restoreFiles(root, dirty);
  if (!restored.ok) refuse(`the board files could not go back to HEAD: ${restored.reason}`);
  if (chain.length) {
    const reset = git(root, ["reset", "--keep", "--quiet", preHead]);
    if (reset.status !== 0)
      refuse(`git reset --keep ${short(preHead)} refused: ${first(reset.stderr)}`);
  }
  const lane = { ...ctx, opts: {}, ledger, files: [] };
  const given = giveBack(lane);
  if (given?.mark === "red")
    stop(
      `the stuck cut's commits are off ${main} (back at ${short(preHead)}), but the writes it set aside did not go back: ${[given.detail, ...given.more].join("; ")}`,
    );
  const state = merge.stateBefore ?? ledger.state;
  save(lane, { state, merge: undefined });
  stop(
    `rolled back the stuck cut: ${main} is back at ${short(preHead)}${chain.length ? ` (${chain.length} commit(s) off it)` : ""}, the set-aside writes are back and ${id} is ${state} again → run exec cut again`,
  );
}
