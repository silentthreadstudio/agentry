// merge/main-row — main's checkout before a land: on the main branch, and clean but for what the land may
// carry. Exec leaves its lifecycle writes uncommitted on main; the land takes main's edits only when they
// are exactly lifecycle cells of tasks with an open lane (`board-diff`, against HEAD), and lists them in
// `lane.carried` with their cells (`merge/carry.mjs` records and sets them aside). The owner's plain edits
// of `guard.allow` files, new untracked ones, and files only `agentry board add` / `board set --apply`
// changed are listed too (`merge/aside.mjs` sets them aside). Anything else refuses, each change named, as
// does a pick that would run into what main carries.
import { posix } from "node:path";
import { boardFiles, cellText, diffBoard, strayChanges } from "../../process/board-diff.mjs";
import { currentBranch } from "../../process/git.mjs";
import { globMatch } from "../../process/glob.mjs";
import { list as listLedgers } from "../../process/ledger.mjs";
import { addedRows, headBoard, recordedFor, workingBoard, writtenByScript } from "../carry-io.mjs";
import { commitOf, filesOf, notEdits, statusEntries, toLand } from "../land.mjs";
import { git } from "../worktree.mjs";
import { cellLine } from "./carry.mjs";
import { ok, red, short } from "./lane.mjs";
import { listedTip } from "./rows.mjs";

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
// A glob test with the gate's own matcher, as exec's guard does.
const matchesAny = (globs, path) => globMatch(globs, path);
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
  // Planned from the listed tip `ledgerStep` resolved, as the picks are: never the branch read by name.
  const tip = listedTip(lane);
  const plan = tip ? toLand(root, { main: ledger.mainBranch, branch: tip }) : { error: true };
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
  const writeFate =
    carry && lane.spec.lifecycle
      ? "set aside for the land, then carried into the board commit"
      : fate;
  const writeLine = lane.writes.files.map(
    (file) => `${file}: written by ${lane.writes.by[file].join("; ")}, uncommitted; ${writeFate}`,
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
