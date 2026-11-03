// merge/carry — main's checkout before a land, and the carry of exec's uncommitted board writes (plan
// R1b-5). Exec leaves its lifecycle writes uncommitted on main. The land takes main's edits only when
// they are exactly lifecycle cells of tasks with an open lane (`board-diff`, against HEAD), records them
// in the ledger (`merge.carry`: the cells, each with its text before and after, and the patch, each with
// its sha256) and only then sets them aside, so the picks, the gate and a rollback see a clean tree and
// a killed run cannot lose them. They go into the board commit, or back onto main at a stop or on the
// next run, cell by cell at the model level: found by task id, so a row another lane writes meanwhile
// does not matter. A carried cell that reads something else by then is a conflict: it blocks the land
// until the owner passes `--drop-carry` (the patch is kept in the run directory).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cellText, diffBoard, strayChanges } from "../../process/board-diff.mjs";
import { list as listLedgers, runDir } from "../../process/ledger.mjs";
import { headBoard, putCells, sha256, uncommittedPatch, workingBoard } from "../carry-io.mjs";
import { commitOf, currentBranch, notEdits, restoreFiles, statusEntries } from "../land.mjs";
import { now, ok, red, setMerge, short } from "./lane.mjs";

// A lane in any other state is open: its task is not on main, so its lifecycle writes may wait there.
const CLOSED = ["merged", "closed"];
const CARRY_RULE =
  "only lifecycle cells (status, verdict, commit) of tasks with an open lane may wait on main for the land";

// Why main's uncommitted edits of `files` cannot wait for the land, one line each; [] when they are
// exactly lifecycle cells of tasks whose lane is open (exec's writes), read at the model level against
// HEAD; a change in a file of `ignore` is left out. The cells found, with their text on HEAD (`from`)
// and on the tree (`to`), are kept in `lane.carryCells`: the ledger records them, and the land sets
// them back from that record.
function carryProblems(lane, files, ignore) {
  const { root, spec, id } = lane;
  if (!spec.lifecycle) return files.map((file) => `${file}: the lifecycle is off; no write waits`);
  const after = workingBoard(root, spec);
  const before = headBoard(root, spec, after.model);
  const all = diffBoard({ spec, before, after, files });
  const kept = (change) => !ignore.includes(change.file);
  const diff = { cells: all.cells.filter(kept), other: all.other.filter(kept) };
  lane.carryCells = diff.cells.map(({ kind, id: item, field, column, file }) => {
    const where = { kind, id: item, column };
    const [from, to] = [cellText(spec, before, where), cellText(spec, after, where)];
    return { kind, id: item, field, column, file, from, to };
  });
  const open = listLedgers(root).filter((l) => !CLOSED.includes(l.state));
  const sameText = files
    .filter((file) => before.text(file) !== null && before.text(file) === after.text(file))
    .map((file) => `${file}: changed, but not in its text (its mode?)`);
  const unread = lane.carryCells
    .filter((c) => c.from === null || c.to === null)
    .map((c) => `${c.file}: ${c.id} ${c.field} cannot be read back by its id, so not set back`);
  return [
    ...sameText,
    ...strayChanges(spec, diff, { ids: [id, ...open.map((l) => l.id)] }),
    ...unread,
  ];
}
const show = (text) => JSON.stringify(text ?? "");
const cellLine = (c) => `${c.id} ${c.field}: ${show(c.from)} → ${show(c.to)} (${c.file})`;
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

/** Main's checkout: on the main branch and clean. With `carry`, uncommitted edits that are exactly
 *  lifecycle cells of open lanes (exec's writes) are allowed too and listed in `lane.carried`; anything
 *  else refuses, each change named. `ignore`: files left out (a killed land's own board writes, which
 *  the land clears first). */
export function mainRow(lane, { carry = false, ignore = [] } = {}) {
  const { root, ledger } = lane;
  lane.carried = [];
  const on = currentBranch(root);
  if (on !== ledger.mainBranch)
    return red(
      "main",
      `the main checkout is on ${on ?? "a detached HEAD"}, not ${ledger.mainBranch}`,
    );
  const all = statusEntries(root);
  if (!all) return red("main", "git status failed in the main checkout");
  const entries = all.filter((entry) => !ignore.includes(entry.slice(3)));
  const at = `${ledger.mainBranch} at ${short(commitOf(root, "HEAD"))}`;
  if (entries.length === 0) return ok("main", `${at}, clean`);
  const files = entries.map((entry) => entry.slice(3));
  const dirty = carry ? notEdits(entries, files) : entries;
  if (dirty.length > 0) {
    const ours = dirty.some((entry) => entry.slice(3).startsWith(".agentry/run/"));
    return red("main", `${ledger.mainBranch} is not clean: ${dirty.length} change(s)`, [
      ...dirty.slice(0, 10),
      ...(carry ? [`${CARRY_RULE}; commit or undo the rest, then land again`] : []),
      ...(ours ? ["add .agentry/run/ to .gitignore: the lane's own files live there"] : []),
    ]);
  }
  const problems = carryProblems(lane, files, ignore);
  if (problems.length > 0)
    return red(
      "main",
      `${ledger.mainBranch} has ${problems.length} uncommitted change(s) the land cannot carry`,
      [...problems.slice(0, 10), `${CARRY_RULE}; commit or undo the rest, then land again`],
    );
  lane.carried = files;
  return ok("main", `${at}, clean but for exec's uncommitted lifecycle writes`, [
    ...lane.carryCells.map(cellLine),
    `${files.join(", ")}: set aside for the land, then carried into the board commit`,
  ]);
}

/** The land's `main` step: main's checkout, exec's writes allowed. */
export function mainStep(lane, rows) {
  const main = mainRow(lane, { carry: true });
  rows.push(main);
  return main.mark === "red" ? { exit: 2 } : null;
}

export const dropNext = (lane) =>
  `look at git diff on ${lane.ledger.mainBranch} and the patch in the ledger (merge.carry); to land without exec's writes: lane merge ${lane.id} --message "<board commit message>" --drop-carry`;

/** Put the carry the ledger holds back onto main's board, cell by cell (`putCells`), and let go of it
 *  there. A cell already back (a run killed before it set the carry aside) is left as it is. A carried
 *  cell that reads anything else now is a conflict: nothing is written and the ledger keeps the carry.
 *  A row, or null when the ledger holds none. */
export function giveBack(lane) {
  const carry = lane.ledger.merge?.carry;
  if (!carry) return null;
  const files = carry.files.join(", ");
  if (!intact(carry))
    return red("carry", `exec's board writes in the ledger (${files}) fail their sha256 check`, [
      // A carry with no cells was recorded before cells were (dev.4): not tampered with, just old.
      carry.cells === undefined
        ? "recorded by an older version; rerun with --drop-carry (the patch is kept)"
        : "the ledger was edited; nothing is put back",
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
  const merge = lane.ledger.merge;
  if (!merge?.carry) return null;
  if (lane.opts["--drop-carry"]) {
    const { carry, droppedCarries = [] } = merge;
    const n = droppedCarries.length + 1;
    const file = join(runDir(lane.root, lane.id), `merge-carry-dropped-${n}.patch`);
    writeFileSync(file, carry.patch);
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
  const back = giveBack(lane);
  rows.push(back);
  return back.mark === "red" ? { exit: 1, keepCarry: true, next: dropNext(lane) } : null;
}

/** Record main's carry-able edits in the ledger (the patch and its sha256), and only then set them
 *  aside, so the picks, the gate and a rollback see a clean tree and a killed run cannot lose them. */
export function takeCarryStep(lane, rows) {
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
