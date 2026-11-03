// merge/carry — main's checkout before a land, and the carry of exec's uncommitted board writes (plan
// R1b-5). Exec leaves its lifecycle writes uncommitted on main. The land takes main's edits only when
// they are exactly lifecycle cells of tasks with an open lane (`board-diff`, against HEAD), records them
// in the ledger (`merge.carry`: the cells, each with its text before and after, and the patch, each with
// its sha256) and only then sets them aside, so the picks, the gate and a rollback see a clean tree and
// a killed run cannot lose them. They go into the board commit, or back onto main at a stop or on the
// next run, cell by cell at the model level: found by task id, so a row another lane writes meanwhile
// does not matter. A carried cell that reads something else by then is a conflict: it blocks the land
// until the owner passes `--drop-carry` (the patch is kept in the run directory).
//
// The owner's own uncommitted edits to files `guard.allow` names (a status file, a plan) are not exec's
// writes and need no board cell, but the picks, the gate and the board commit all need a clean tree. So
// the land sets them aside the same way (the patch and its sha256 in `merge.allow`, recorded first), and
// puts them back after the board commit, at any stop, or first thing on the rerun of a killed land. An
// edit that no longer applies on the landed files is saved to a patch file and said, never lost. A new,
// untracked file under `guard.allow` is carried the same way (its patch is a new-file patch; set aside
// is deleting it), and so is a file only `agentry board add` / `board set --apply` changed, by the
// content ids they recorded (`merge.writes`, the same record plus the cells for a pick that touches
// the file). Those two are never committed by the land: they go back to the owner uncommitted.
import { isUtf8 } from "node:buffer";
import { existsSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { boardFiles, cellText, diffBoard, strayChanges } from "../../process/board-diff.mjs";
import { list as listLedgers, runDir } from "../../process/ledger.mjs";
import {
  addedRows,
  applyPatch,
  asidePatch,
  headBoard,
  planRows,
  putCells,
  recordedFor,
  removeFiles,
  sha256,
  uncommittedPatch,
  workingBoard,
  writtenByScript,
} from "../carry-io.mjs";
import { pickTier } from "../gate.mjs";
import {
  commitOf,
  currentBranch,
  filesOf,
  notEdits,
  restoreFiles,
  statusEntries,
  toLand,
} from "../land.mjs";
import { git } from "../worktree.mjs";
import { landNext, now, ok, red, setMerge, short, warn } from "./lane.mjs";

// A lane in any other state is open: its task is not on main, so its lifecycle writes may wait there.
const CLOSED = ["merged", "closed"];
const CARRY_RULE =
  "only lifecycle cells (status, verdict, commit) of tasks with an open lane may wait on main for the land";

// The changed `cells` of a board diff with their text on each side, found by id (null: not read back).
const readCells = (spec, before, after, cells) =>
  cells.map(({ kind, id, field, column, file }) => {
    const where = { kind, id, column };
    return {
      kind,
      id,
      field,
      column,
      file,
      from: cellText(spec, before, where),
      to: cellText(spec, after, where),
    };
  });

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
  // The files only recorded board writes changed are carried as such (`scriptWrites`), not as exec's.
  const kept = (change) =>
    !ignore.includes(change.file) && !lane.writes.files.includes(change.file);
  const diff = { cells: all.cells.filter(kept), other: all.other.filter(kept) };
  lane.carryCells = readCells(spec, before, after, diff.cells);
  const open = listLedgers(root).filter((l) => !CLOSED.includes(l.state));
  const sameText = files
    .filter((file) => before.text(file) !== null && before.text(file) === after.text(file))
    .map((file) => `${file}: changed, but not in its text (its mode?)`);
  const unread = lane.carryCells
    .filter((c) => c.from === null || c.to === null)
    .map((c) => `${c.file}: ${c.id} ${c.field} cannot be read back by its id, so not set back`);
  const shared = sharedFiles(lane, diff);
  const alone = {
    cells: diff.cells,
    other: diff.other.filter((o) => !Object.hasOwn(shared, o.file)),
  };
  const stray = strayChanges(spec, alone, { ids: [id, ...open.map((l) => l.id)] }).map((line) =>
    line.replace(/: not a board file$/, ": not a board file, not in guard.allow"),
  );
  const both = Object.entries(shared).map(
    ([file, { lanes, by }]) =>
      `${file}: a lifecycle write by ${lanes} and a board add by ${by} share this file → land ${lanes} first, or commit the added row`,
  );
  return [...sameText, ...both, ...stray, ...unread];
}
// The board files of `diff` that hold an exec lifecycle write (a cell) and a recorded `board add` / `board
// set` too, which `writtenByScript` cannot take as the script's alone: `{ file: { lanes, by } }`, the ids
// of the cells' tasks and the recorded writes' `by`, each joined.
function sharedFiles({ root }, diff) {
  const cellFiles = [...new Set(diff.cells.map((c) => c.file))].filter((file) =>
    diff.other.some((o) => o.file === file),
  );
  let log;
  try {
    log = recordedFor(root, cellFiles);
  } catch {
    return {}; // git cannot say: the file stays plain dirt
  }
  return Object.fromEntries(
    Object.entries(log).map(([file, by]) => [
      file,
      {
        lanes: [...new Set(diff.cells.filter((c) => c.file === file).map((c) => c.id))].join(", "),
        by: [...new Set(by)].join("; "),
      },
    ]),
  );
}
// A glob test with the gate's own matcher (a quick tier whose only globs are these), as exec's guard does.
const matchesAny = (globs, path) =>
  globs.length > 0 && pickTier({ quick: { command: ["-"], only: globs } }, [path]).tier === "quick";
const PLAIN_EDIT = /^(?: M|M |MM)$/;

// The entries that are the owner's plain edits of a `guard.allow` file, or a new untracked one. A board
// file is never one: its edits are exec's lifecycle writes, carried into the board commit.
function allowedEdits({ spec, model }, entries) {
  const globs = spec.guard?.allow ?? [];
  if (globs.length === 0) return [];
  const board = new Set(boardFiles(spec, model ?? { kinds: {} }));
  return entries.filter((entry) => {
    const [how, path] = [entry.slice(0, 2), entry.slice(3)];
    return (PLAIN_EDIT.test(how) || how === "??") && !board.has(path) && matchesAny(globs, path);
  });
}

// The files among `entries` (plain edits) that only recorded board-script writes changed, with what to
// say about them: `{ files, by, cells, loose, rows }`. `cells` are the cell changes of the files a pick could
// be merged with by cell; `loose` are those it could not (a row added, prose, a cell not read by its id);
// `rows` are the rows added to a loose file when that is all it changed, so they can be put back by their
// neighbour's id on a file the land itself rewrote.
function scriptWrites(lane, entries) {
  const { root, spec } = lane;
  const none = { files: [], by: {}, cells: [], loose: [], rows: [] };
  const plain = entries.filter((e) => PLAIN_EDIT.test(e.slice(0, 2))).map((e) => e.slice(3));
  let by;
  try {
    by = writtenByScript(root, plain);
  } catch {
    return none; // git cannot say: the files stay what they were, dirt
  }
  const files = Object.keys(by);
  if (files.length === 0) return none;
  try {
    const after = workingBoard(root, spec);
    const before = headBoard(root, spec, after.model);
    const diff = diffBoard({ spec, before, after, files });
    const cells = readCells(spec, before, after, diff.cells);
    const loose = files.filter(
      (file) =>
        diff.other.some((o) => o.file === file) ||
        !cells.some((c) => c.file === file) ||
        cells.some((c) => c.file === file && (c.from === null || c.to === null)),
    );
    const idColumn = (file) => (heading) =>
      Object.values(spec.kinds ?? {}).find(
        (kind) =>
          kind.at?.heading === heading && posix.join(spec.root ?? ".", kind.at.table) === file,
      )?.id?.column;
    const rows = loose.flatMap((file) =>
      (addedRows(before.text(file) ?? "", after.text(file) ?? "", idColumn(file)) ?? []).map(
        (row) => ({ file, ...row }),
      ),
    );
    return { files, by, cells: cells.filter((c) => !loose.includes(c.file)), loose, rows };
  } catch {
    return { files, by, cells: [], loose: files, rows: [] };
  }
}

// The git-added path list of commit `sha`.
function addedBy(root, sha) {
  const res = git(root, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "--diff-filter=A",
    "-z",
    "-r",
    sha,
    "--",
  ]);
  return res.status === 0 ? res.stdout.split("\0").filter(Boolean) : [];
}

// Why a pick would run into what main carries, before any pick: an untracked guard.allow file a picked
// commit adds, or a board-script write a picked commit touches that cannot merge by cell. One line each.
function pickProblems(lane) {
  const { root, spec, ledger, allowNew, writes } = lane;
  if (allowNew.length === 0 && writes.loose.length === 0 && writes.cells.length === 0) return [];
  const plan = toLand(root, { main: ledger.mainBranch, branch: ledger.branch });
  if (plan.error) return []; // the commits row says so
  const model = writes.cells.length > 0 ? workingBoard(root, spec).model : null;
  // Does commit `sha` change a cell the owner's board set wrote in `file`, or take its row away?
  const touchesCells = (sha, file) => {
    const cells = writes.cells.filter((c) => c.file === file);
    try {
      const [x, y] = [`${sha}^`, sha].map((rev) => headBoard(root, spec, model, rev));
      return cells.some((c) => {
        const where = { kind: c.kind, id: c.id, column: c.column };
        return cellText(spec, x, where) !== cellText(spec, y, where);
      });
    } catch {
      return true; // unreadable: not merged by guess
    }
  };
  const seen = new Set();
  const out = [];
  for (const sha of plan.picks) {
    const touched = filesOf(root, sha) ?? [];
    const lines = [
      ...addedBy(root, sha)
        .filter((path) => allowNew.includes(path))
        .map((path) => [
          path,
          `${path}: untracked on main and added by ${short(sha)} → move it aside or commit it, then rerun`,
        ]),
      ...[...writes.loose, ...writes.cells.map((c) => c.file)]
        .filter((file, i, all) => all.indexOf(file) === i && touched.includes(file))
        .filter((file) => writes.loose.includes(file) || touchesCells(sha, file))
        .map((file) => [
          file,
          `${file}: written on main by ${writes.by[file].join("; ")} and changed by ${short(sha)}, which cannot merge by cell → commit or undo the write, then rerun`,
        ]),
    ];
    for (const [path, line] of lines)
      if (!seen.has(path)) {
        seen.add(path);
        out.push(line);
      }
  }
  return out;
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
 *  else refuses, each change named. The owner's plain edits of `guard.allow` files are allowed in every
 *  mode and listed in `lane.allowFiles` (the land sets them aside). `ignore`: files left out (a killed
 *  land's own board writes, which the land clears first). */
export function mainRow(lane, { carry = false, ignore = [] } = {}) {
  const { root, ledger } = lane;
  lane.carried = [];
  lane.allowFiles = [];
  lane.allowNew = [];
  lane.writes = { files: [], by: {}, cells: [], loose: [], rows: [] };
  const on = currentBranch(root);
  if (on !== ledger.mainBranch)
    return red(
      "main",
      `the main checkout is on ${on ?? "a detached HEAD"}, not ${ledger.mainBranch}`,
    );
  const all = statusEntries(root);
  if (!all) return red("main", "git status failed in the main checkout");
  const rest = all.filter((entry) => !ignore.includes(entry.slice(3)));
  lane.writes = scriptWrites(lane, rest);
  const scripted = (entry) =>
    PLAIN_EDIT.test(entry.slice(0, 2)) && lane.writes.files.includes(entry.slice(3));
  const left = rest.filter((entry) => !scripted(entry));
  const kept = allowedEdits(lane, left);
  lane.allowFiles = kept.map((entry) => entry.slice(3));
  lane.allowNew = kept.filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3));
  const entries = left.filter((entry) => !kept.includes(entry));
  const at = `${ledger.mainBranch} at ${short(commitOf(root, "HEAD"))}`;
  const fate = carry ? "set aside for the land, then put back as they were" : "left as they are";
  const allowLine =
    kept.length > 0 ? [`${lane.allowFiles.join(", ")}: uncommitted, in guard.allow; ${fate}`] : [];
  const writeLine = lane.writes.files.map(
    (file) => `${file}: written by ${lane.writes.by[file].join("; ")}, uncommitted; ${fate}`,
  );
  const extras = [
    ...(kept.length > 0 ? ["guard.allow edits"] : []),
    ...(lane.writes.files.length > 0 ? ["recorded board writes"] : []),
  ];
  const but = extras.length > 0 ? ` but for ${extras.join(" and ")}` : "";
  const stuck = pickProblems(lane);
  if (stuck.length > 0) return red("main", stuck[0], stuck.slice(1, 10));
  if (entries.length === 0) return ok("main", `${at}, clean${but}`, [...allowLine, ...writeLine]);
  const files = entries.map((entry) => entry.slice(3));
  const dirty = carry ? notEdits(entries, files) : entries;
  if (dirty.length > 0) {
    const ours = dirty.some((entry) => entry.slice(3).startsWith(".agentry/run/"));
    return red(
      "main",
      `${ledger.mainBranch} is not clean: ${dirty.length} change(s) not in guard.allow`,
      [
        ...dirty.slice(0, 10),
        ...(carry ? [`${CARRY_RULE}; commit or undo the rest, then land again`] : []),
        ...(ours ? ["add .agentry/run/ to .gitignore: the lane's own files live there"] : []),
      ],
    );
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
    ...allowLine,
    ...writeLine,
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
  const edits = putBackAllow(lane);
  const carry = giveBackCarry(lane);
  if (!edits || !carry) return edits ?? carry;
  const mark = carry.mark === "red" || edits.mark === "red" ? "red" : carry.mark;
  return { ...carry, mark, more: [...carry.more, edits.detail, ...edits.more] };
}

function giveBackCarry(lane) {
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

// The two records of files set aside to be put back uncommitted: the owner's `guard.allow` edits and new
// files (`merge.allow`) and the files only board-script writes changed (`merge.writes`, with the cells a
// pick that touched the file is merged back by).
const ALLOW = {
  key: "allow",
  noun: "guard.allow file(s)",
  edits: "guard.allow edits",
  patch: "merge-allow",
  files: (lane) => lane.allowFiles ?? [],
  untracked: (lane) => lane.allowNew ?? [],
  cells: () => undefined,
  rows: () => undefined,
};
const WRITES = {
  key: "writes",
  noun: "board-write file(s)",
  edits: "board writes",
  patch: "merge-writes",
  files: (lane) => lane.writes?.files ?? [],
  untracked: () => [],
  cells: (lane) => lane.writes?.cells,
  rows: (lane) => lane.writes?.rows,
};

/** Record `kind`'s files in the ledger (the patch and its sha256), then set them aside: put back to HEAD,
 *  or deleted when HEAD does not hold them. */
function takeAside(lane, rows, kind) {
  const files = kind.files(lane);
  if (files.length === 0) return null;
  const untracked = kind.untracked(lane);
  const made = asidePatch(lane.root, files, untracked);
  if (made.error) {
    rows.push(red(kind.key, `cannot read the ${kind.edits}: ${made.error}`));
    return { exit: 1 };
  }
  const [cells, added] = [kind.cells(lane), kind.rows(lane)];
  const cellsSha256 = cells && sha256(JSON.stringify([cells, added ?? []]));
  setMerge(lane, {
    [kind.key]: {
      enc: "bytes",
      files,
      untracked,
      patch: made.patch,
      sha256: made.sha256,
      cells,
      rows: added,
      cellsSha256,
      at: now(),
    },
  });
  const aside = restoreFiles(
    lane.root,
    files.filter((file) => !untracked.includes(file)),
  );
  const gone = aside.ok ? removeFiles(lane.root, untracked) : aside;
  if (!gone.ok) {
    rows.push(red(kind.key, `could not set the ${kind.edits} aside: ${gone.reason}`));
    return { exit: 1 };
  }
  rows.push(
    ok(kind.key, `${files.length} ${kind.noun} set aside, recorded in the ledger first`, [
      `${files.join(", ")}: sha256 ${made.sha256.slice(0, 12)}…, put back after the land`,
    ]),
  );
  return null;
}

// Where an edit that cannot go back is kept: the first <name>-<n>.patch the run directory lacks.
function keepPatch(lane, name, patch) {
  const dir = runDir(lane.root, lane.id);
  let n = 1;
  while (existsSync(join(dir, `${name}-${n}.patch`))) n++;
  const file = join(dir, `${name}-${n}.patch`);
  writeFileSync(file, patch, "latin1"); // the patch is bytes kept one per char
  return file;
}

/** Put the files `kind`'s record holds back onto main's working tree and let go of them. Edits already
 *  back (a run killed after it put them back) are left. A file a pick changed is merged back by cell when
 *  the record has its cells. Edits that no longer apply, or whose record fails its sha256, are saved to a
 *  patch file and said (a warning: the land is not undone for them, and nothing is lost). A row, or null
 *  when the ledger holds none. */
function putBackAside(lane, kind) {
  const held = lane.ledger.merge?.[kind.key];
  if (!held) return null;
  if (isOld(held)) return oldRecord(lane, kind, held);
  const files = held.files.join(", ");
  const [cells, added] = [held.cells ?? [], held.rows ?? []];
  const both = bothKinds(held);
  if (both) throw new Error(`carry: ${bothMessage(both)}`);
  const apply = (...flags) => applyPatch(lane.root, held.patch, ...flags);
  const intactRecord = sha256(held.patch) === held.sha256;
  const done = (row) => {
    setMerge(lane, { [kind.key]: undefined }); // only once the edits are on main or in a patch file
    return row;
  };
  if (intactRecord && apply("--reverse", "--check").status === 0)
    return done(ok(kind.key, `${kind.edits} are on main already (${files})`));
  if (intactRecord && apply().status === 0)
    return done(
      ok(kind.key, `${kind.edits} are on main again, uncommitted, as they were (${files})`),
    );
  // A file a pick or the board commit changed: set again by the cell ids and the rows' neighbours.
  const covered = held.files.every(
    (file) => cells.some((c) => c.file === file) || added.some((r) => r.file === file),
  );
  if (intactRecord && covered && sha256(JSON.stringify([cells, added])) === held.cellsSha256) {
    const plan = planRows(lane.root, added);
    const back = plan.ok ? putCells(lane.root, lane.spec, cells) : plan;
    if (back.ok) {
      plan.write();
      const how = [cells.length > 0 && "cell by cell", added.length > 0 && "row by row"];
      return done(
        ok(
          kind.key,
          `${kind.edits} are on main again, uncommitted, set ${how.filter(Boolean).join(" and ")} on the landed files (${files})`,
        ),
      );
    }
  }
  const file = keepPatch(lane, kind.patch, held.patch);
  const why = intactRecord
    ? "they no longer apply to the landed files"
    : "the ledger's copy fails its sha256 check";
  return done(
    warn(kind.key, `${kind.edits} were not put back (${files}): ${why}`, [
      `your edits are saved in ${file}: look at them, then git apply it by hand`,
    ]),
  );
}

// The first file of `held` that has both recorded cells and added rows (never made by `scriptWrites`).
const bothKinds = (held) =>
  held.files.find(
    (file) =>
      (held.cells ?? []).some((c) => c.file === file) &&
      (held.rows ?? []).some((r) => r.file === file),
  );
const bothMessage = (file) => `${file} has both cells and rows; this is a bug, nothing was written`;

// A record without `enc: "bytes"` was written before the patch was kept as bytes (a text patch): it is
// never applied, whatever it holds.
const isOld = (held) => held.enc !== "bytes";
/** Does the ledger's `merge` hold a set-aside record written by an older version? `--drop-carry` drops it. */
export const hasOldRecord = (merge) =>
  [ALLOW, WRITES].some((kind) => merge?.[kind.key] && isOld(merge[kind.key]));
const DROP_CARRY = " --drop-carry";
/** The stop for a put-back row that refused (red: an old record, or a record that is a bug), else null. */
export function backStop(lane, back) {
  if (back?.mark !== "red") return null;
  const old = hasOldRecord(lane.ledger.merge);
  const next = old
    ? `restore the kept patch by hand, then ${landCommand(lane)}${DROP_CARRY}`
    : "show the owner the carry row: nothing was written or put back";
  return { exit: 2, keepCarry: true, next };
}

// The bytes of an old record's patch. Before the byte fix the patch was UTF-8-decoded text; after it, a
// latin1 string. A string with a character above U+00FF, or whose latin1 bytes are not valid UTF-8, was
// decoded from UTF-8 text and goes back as UTF-8; any other is the latin1 bytes.
function oldPatchBytes(patch) {
  const text = String(patch ?? "");
  const latin1 = Buffer.from(text, "latin1");
  const wide = [...text].some((ch) => ch.codePointAt(0) > 0xff);
  return wide || (/[\u0080-\u00ff]/.test(text) && !isUtf8(latin1))
    ? Buffer.from(text, "utf8")
    : latin1;
}

// An old record's patch kept once in the run dir (`patchFile` in the record: a rerun names the same file),
// then a red row that stops the land, or on `--drop-carry` an ok row and the record let go.
function oldRecord(lane, kind, held) {
  let file = held.patchFile;
  if (!file) {
    const dir = runDir(lane.root, lane.id);
    let n = 1;
    while (existsSync(join(dir, `${kind.patch}-${n}.patch`))) n++;
    file = join(dir, `${kind.patch}-${n}.patch`);
  }
  if (!existsSync(file)) writeFileSync(file, oldPatchBytes(held.patch));
  if (lane.opts?.["--drop-carry"]) {
    setMerge(lane, { [kind.key]: undefined });
    return ok(
      "carry",
      `dropped ${kind.edits} recorded by an older version (the owner's --drop-carry)`,
      [
        `${held.files.join(", ")}: the patch is kept in ${file} (git apply it by hand if it matters)`,
      ],
    );
  }
  if (held.patchFile !== file) setMerge(lane, { [kind.key]: { ...held, patchFile: file } });
  return red(
    "carry",
    `recorded by an older version (text patch) → restore it by hand from ${file}, then rerun with --drop-carry`,
  );
}

const WORST = ["red", "warn", "ok"];
/** Put back what the ledger holds of the owner's `guard.allow` files and of board-script writes: one
 *  row, or null when it holds none. An old record refuses (a red row, nothing put back) unless the owner
 *  passed `--drop-carry`. */
export function putBackAllow(lane) {
  const kinds = [ALLOW, WRITES];
  // A record that is a bug stops everything before the first one is put back.
  for (const kind of kinds) {
    const held = lane.ledger.merge?.[kind.key];
    const both = held && !isOld(held) && bothKinds(held);
    if (both) return red("carry", bothMessage(both));
  }
  const old = kinds.filter(
    (kind) => lane.ledger.merge?.[kind.key] && isOld(lane.ledger.merge[kind.key]),
  );
  const refuse = old.length > 0 && !lane.opts?.["--drop-carry"];
  const rows = (refuse ? old : kinds).map((kind) => putBackAside(lane, kind)).filter(Boolean);
  if (rows.length === 0) return null;
  const [first, ...rest] = rows;
  const mark = WORST.find((m) => rows.some((r) => r.mark === m));
  return { ...first, mark, more: [...first.more, ...rest.flatMap((r) => [r.detail, ...r.more])] };
}

const SAFE_WORD = /^[A-Za-z0-9_./:=@%+-]+$/;
// `word` as one shell word: bare when it is only safe characters (and not a leading `-`, an option, or `=`,
// which zsh expands), else single-quoted.
const quote = (word) =>
  SAFE_WORD.test(word) && !/^[-=]/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

// The land command as this call ran it, every argument one shell word, so the line can be run as it stands.
function landCommand({ id, opts }) {
  const message = opts?.["--message"];
  if (message === undefined) return landNext(id);
  const flag = (name) => (opts[name] === undefined ? [] : [name, quote(opts[name])]);
  return [
    "lane",
    "merge",
    quote(id),
    ...flag("--branch"),
    "--message",
    quote(message),
    ...flag("--summary"),
  ].join(" ");
}

/** The row for a stop that keeps the ledger's set-aside files (nothing put them back yet): which they
 *  are and the command that does, so a hold is never silent. Null when the ledger holds none. */
export function heldRow(lane) {
  const held = [ALLOW, WRITES].flatMap((kind) => {
    const record = lane.ledger.merge?.[kind.key];
    return record && !isOld(record) ? record.files : []; // an old record is never restored by this command
  });
  if (held.length === 0) return null;
  const command = landCommand(lane) + (hasOldRecord(lane.ledger.merge) ? DROP_CARRY : "");
  const shown = held.slice(0, 5).join(", ") + (held.length > 5 ? `, +${held.length - 5}` : "");
  return warn("allow", "files set aside by this land are still in the ledger", [
    `allow: ${held.length} file(s) set aside (${shown}) → restored by ${command}`,
  ]);
}
