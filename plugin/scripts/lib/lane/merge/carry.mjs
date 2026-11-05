// merge/carry — the carry of exec's uncommitted board writes (plan R1b-5). The land records main's
// lifecycle cells (`merge/main-row.mjs` found them) in the ledger (`merge.carry`: the cells, each with its
// text before and after, and the patch, each with its sha256) and only then sets them aside, so the picks,
// the gate and a rollback see a clean tree and a killed run cannot lose them. They go into the board
// commit, or back onto main at a stop or on the next run, cell by cell at the model level: found by task
// id, so a row another lane writes meanwhile does not matter. A carried cell that reads something else by
// then is a conflict: it blocks the land until the owner passes `--drop-carry` (the patch is kept in the
// run directory). The `guard.allow` and board-script files set aside beside it are `merge/aside.mjs`'s.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "../../process/ledger.mjs";
import { putCells, sha256, uncommittedPatch } from "../carry-io.mjs";
import { restoreFiles } from "../land.mjs";
import { ALLOW, WRITES, backStop, putBackAllow, takeAside } from "./aside.mjs";
import { now, ok, red, setMerge } from "./lane.mjs";
import { OLD_CARRY_LINE, isOldCarry } from "./legacy.mjs";

const show = (text) => JSON.stringify(text ?? "");
export const cellLine = (c) => `${c.id} ${c.field}: ${show(c.from)} → ${show(c.to)} (${c.file})`;
// A carried cell that reads neither its text before exec's write nor after it.
export const conflictLine = (c) =>
  c.now === null
    ? `${cellLine(c)}: ${c.id} is not on the board once now`
    : `${cellLine(c)}: it reads ${show(c.now)} now`;
// The ledger's carry is as the land recorded it: its patch and its cells each match their sha256.
const intact = (carry) =>
  sha256(carry.patch) === carry.sha256 &&
  Array.isArray(carry.cells) &&
  sha256(JSON.stringify(carry.cells)) === carry.cellsSha256;

export const dropNext = (lane) =>
  `look at git diff on ${lane.ledger.mainBranch} and the patch in the ledger (merge.carry); to land without exec's writes: lane merge ${lane.id} --message "<board commit message>" --drop-carry`;

/** Put the carry the ledger holds back onto main's board, cell by cell (`putCells`), and let go of it
 *  there. A cell already back (a run killed before it set the carry aside) is left as it is. A carried
 *  cell that reads anything else now is a conflict: nothing is written and the ledger keeps the carry.
 *  A row, or null when the ledger holds none. */
export function giveBack(lane) {
  const edits = putBackAllow(lane);
  const carry = giveBackCarry(lane);
  if (!edits || !carry) return edits ?? carry;
  const mark = carry.mark === "red" || edits.mark === "red" ? "red" : carry.mark;
  const next = [carry, edits].find((r) => r.mark === "red")?.next; // the row that refused says what next
  return { ...carry, mark, next, more: [...carry.more, edits.detail, ...edits.more] };
}

function giveBackCarry(lane) {
  const carry = lane.ledger.merge?.carry;
  if (!carry) return null;
  const files = carry.files.join(", ");
  if (!intact(carry))
    return red("carry", `exec's board writes in the ledger (${files}) fail their sha256 check`, [
      isOldCarry(carry) ? OLD_CARRY_LINE : "the ledger was edited; nothing is put back",
    ]);
  const back = putCells(lane.root, lane.spec, carry.cells);
  if (!back.ok)
    return red("carry", `exec's board writes no longer apply to ${files} on main`, [
      ...back.conflicts.map(conflictLine),
      ...(back.reason ? [back.reason] : []),
      "nothing is written; they stay in the ledger (merge.carry): nothing is dropped without --drop-carry",
    ]);
  setMerge(lane, { carry: undefined });
  return ok("carry", `exec's board writes are on main again, uncommitted, as they were (${files})`);
}

/** The carry an earlier run set aside: back onto main before anything else, or dropped on the owner's
 *  --drop-carry (its patch kept in the run directory). One that no longer applies blocks the land. */
export function carryBackStep(lane, rows) {
  const edits = putBackAllow(lane);
  if (edits) rows.push(edits);
  const stop = backStop(lane, edits);
  if (stop) return stop;
  const merge = lane.ledger.merge;
  if (!merge?.carry) return null;
  if (lane.opts["--drop-carry"]) {
    const { carry, droppedCarries = [] } = merge;
    const n = droppedCarries.length + 1;
    const file = join(runDir(lane.root, lane.id), `merge-carry-dropped-${n}.patch`);
    writeFileSync(file, carry.patch, "latin1");
    // A carried cell still on the tree (a run killed before it set the carry aside) comes off it too:
    // dropped means the land goes on without those edits, not that it takes them again as a new carry.
    // A cell that reads anything else is not exec's write any more: it is left as it is.
    const flipped = (carry.cells ?? []).map((c) => ({ ...c, from: c.to, to: c.from }));
    const off = putCells(lane.root, lane.spec, flipped, { leave: true });
    if (!off.ok) {
      rows.push(red("carry", `cannot take exec's board writes off main: ${off.reason}`));
      return { exit: 1, keepCarry: true, next: dropNext(lane) };
    }
    const there = off.set.length > 0;
    const dropped = { files: carry.files, sha256: carry.sha256, patchFile: file, at: now() };
    setMerge(lane, { carry: undefined, droppedCarries: [...droppedCarries, dropped] });
    const detail = `dropped exec's board writes (the owner's --drop-carry)${there ? ", off main too" : ""}`;
    rows.push(
      ok("carry", detail, [
        `${carry.files.join(", ")}: the patch is kept in ${file} (git apply it by hand if its cells matter)`,
      ]),
    );
    return null;
  }
  const back = giveBackCarry(lane);
  rows.push(back);
  return back.mark === "red" ? { exit: 1, keepCarry: true, next: dropNext(lane) } : null;
}

/** Record main's carry-able edits in the ledger (the patch and its sha256), and only then set them
 *  aside, so the picks, the gate and a rollback see a clean tree and a killed run cannot lose them. */
export function takeCarryStep(lane, rows) {
  return takeLifecycle(lane, rows) ?? takeAside(lane, rows, ALLOW) ?? takeAside(lane, rows, WRITES);
}

function takeLifecycle(lane, rows) {
  const files = lane.carried;
  if (files.length === 0) return null;
  const made = uncommittedPatch(lane.root, files);
  if (made.error) {
    rows.push(red("carry", `cannot read exec's board writes: ${made.error}`));
    return { exit: 1 };
  }
  const cells = lane.carryCells;
  const cellsSha256 = sha256(JSON.stringify(cells));
  setMerge(lane, {
    carry: { files, cells, cellsSha256, patch: made.patch, sha256: made.sha256, at: now() },
  });
  const aside = restoreFiles(lane.root, files);
  if (!aside.ok) {
    rows.push(red("carry", `could not set exec's board writes aside: ${aside.reason}`));
    return { exit: 1 };
  }
  const sum = made.sha256.slice(0, 12);
  rows.push(
    ok("carry", `${files.length} board file(s) set aside, recorded in the ledger first`, [
      `merge.carry: ${cells.length} cell(s) in ${files.join(", ")}, sha256 ${sum}…`,
    ]),
  );
  return null;
}
