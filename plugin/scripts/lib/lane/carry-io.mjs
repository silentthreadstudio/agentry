// carry-io — the I/O behind the carry of exec's uncommitted board writes: the patch and its
// sha256 the ledger keeps of them, the two boards (the working tree's and HEAD's) `board-diff` reads them
// against, and the board writes that put their cells back. `merge/main-row.mjs` decides what may be
// carried; this only reads and writes. Every git call is an argv array; a refusal is `{ ok: false,
// reason }`, not a throw. The same patch holds the owner's `guard.allow` files (a new, untracked one as a
// new-file patch) and the files only `agentry board add` / `board set --apply` changed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boardFiles, cellEdits } from "../process/board-diff.mjs";
import { contentOf } from "../process/board-writes.mjs";
import * as md from "../process/markdown.mjs";
import { readProcess } from "../process/read.mjs";
import { WriteError, applyAll } from "../process/write.mjs";
import { first } from "./fmt.mjs";
import { leaves } from "./paths.mjs";
import { git } from "./worktree.mjs";

// A patch is bytes, not text: it is kept as a latin1 string (one char per byte), so a file that is not
// UTF-8 survives the ledger, the sha256 and `git apply` byte for byte. `worktree.git` decodes as UTF-8.
function rawGit(dir, args, input) {
  const res = spawnSync("git", ["-C", dir, ...args], {
    encoding: "latin1",
    input: input === undefined ? undefined : Buffer.from(input, "latin1"),
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** `git apply --binary <flags>` of a patch this module made (a latin1 string): `{ status, … }`. */
export const applyPatch = (root, patch, ...flags) =>
  rawGit(root, ["apply", "--binary", ...flags], patch);

/** The sha256 of `text`, hex. */
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Where a patch that cannot go back is kept: the first `<name>-<n>.patch` that `dir` lacks. */
export function nextPatchFile(dir, name) {
  let n = 1;
  while (existsSync(join(dir, `${name}-${n}.patch`))) n++;
  return join(dir, `${name}-${n}.patch`);
}

/** The uncommitted edits of `files` against HEAD as one binary patch, and its sha256: `{ patch,
 *  sha256 }`, or `{ error }` when git cannot say. */
export function uncommittedPatch(root, files) {
  const res = rawGit(root, ["--literal-pathspecs", "diff", "--binary", "HEAD", "--", ...files]);
  if (res.status !== 0) return { error: first(res.stderr) || "git diff failed" };
  return { patch: res.stdout, sha256: sha256(res.stdout) };
}

/** The same for `files` of which `untracked` are not on HEAD: those go in as new-file patches (read
 *  from the working tree, `git diff --no-index`), so `git apply` makes them again. */
export function asidePatch(root, files, untracked = []) {
  const parts = [];
  const tracked = files.filter((file) => !untracked.includes(file));
  if (tracked.length > 0) {
    const made = uncommittedPatch(root, tracked);
    if (made.error) return made;
    parts.push(made.patch);
  }
  for (const file of untracked) {
    const res = rawGit(root, ["diff", "--no-index", "--binary", "--", "/dev/null", file]);
    if (res.status !== 1)
      return { error: first(res.stderr) || `git diff --no-index ${file} failed` };
    parts.push(res.stdout);
  }
  const patch = parts.join("");
  return { patch, sha256: sha256(patch) };
}

/** Delete the untracked `files` (repo-relative) from `root`: the set-aside of a file HEAD does not
 *  hold. `{ ok }` or `{ ok: false, reason }`. */
export function removeFiles(root, files) {
  try {
    for (const file of files) rmSync(join(root, file));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// The suffix a content id carries for what the blob id leaves out, by the tree entry's mode.
const MODE_SUFFIX = { 100755: ":x", 120000: ":l" };
/** The content ids (git's blob id, `:x` an executable, `:l` a symlink) of `files` as `commit` holds them,
 *  "-" for a file it lacks: the shape `board-writes.contentOf` gives for the working tree. The carry and
 *  the main guard compare ids from this one encoder. */
export function blobsAt(root, commit, files) {
  const out = Object.fromEntries(files.map((file) => [file, "-"]));
  const res = git(root, ["--literal-pathspecs", "ls-tree", "-r", "-z", commit, "--", ...files]);
  for (const line of res.stdout.split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    const [mode, , id] = line.slice(0, tab).split(" ");
    const file = line.slice(tab + 1);
    if (Object.hasOwn(out, file)) out[file] = id + (MODE_SUFFIX[mode] ?? "");
  }
  return out;
}

// Every write `board add` / `board set --apply` recorded, oldest first: `{ file, from, to, by }`
// (`process/board-writes.mjs` keeps the log; a line that is not a record is left out).
function recordedWrites(root) {
  let text = "";
  try {
    text = readFileSync(join(root, ".agentry", "run", "process", "board-writes.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((raw) => {
    try {
      const r = JSON.parse(raw);
      const fields = [r?.file, r?.from, r?.to, r?.by];
      return fields.every((v) => typeof v === "string")
        ? [{ file: r.file, from: r.from, to: r.to, by: r.by }]
        : [];
    } catch {
      return [];
    }
  });
}

/** The files of `files` (changed on main's working tree) that only recorded board writes changed, content
 *  exact as the main-touched guard reads them: a file's content now is reached from its content on HEAD
 *  through recorded `from → to` moves, and is not HEAD's own. `{ file: [the `by` of each write on that
 *  path] }`; a file with no such path is left out. A hand edit, or a write made after one, is not one. */
export function writtenByScript(root, files) {
  if (files.length === 0) return {};
  const now = contentOf(root, files);
  const head = blobsAt(root, "HEAD", files);
  const log = recordedWrites(root);
  const out = {};
  for (const file of files) {
    if (now[file] === head[file]) continue;
    const moves = log.filter((m) => m.file === file);
    const via = new Map([[head[file], []]]); // content id → the writes that led here
    const queue = [head[file]];
    for (let at = queue.shift(); at !== undefined && !via.has(now[file]); at = queue.shift())
      for (const m of moves)
        if (m.from === at && !via.has(m.to)) {
          via.set(m.to, [...via.get(at), m.by]);
          queue.push(m.to);
        }
    if (via.has(now[file])) out[file] = via.get(now[file]);
  }
  return out;
}

/** The `by` of the recorded writes of each of `files` that start at its content on HEAD or end at its
 *  content now: `{ file: [by, …] }`, a file with none left out. Where `writtenByScript` asks whether the
 *  whole path from HEAD is recorded, this finds a recorded write in a file that has other changes too. */
export function recordedFor(root, files) {
  if (files.length === 0) return {};
  const now = contentOf(root, files);
  const head = blobsAt(root, "HEAD", files);
  const log = recordedWrites(root);
  const out = {};
  for (const file of files) {
    const by = log
      .filter((m) => m.file === file && (m.from === head[file] || m.to === now[file]))
      .map((m) => m.by);
    if (by.length > 0) out[file] = by;
  }
  return out;
}

// A file a ledger record names (a carried cell's or row's): repo-relative and inside the repository, no
// `..` in it at all. A ledger is data, and its sha256 sits in the same file, so a path out of it is never
// read or written.
const leavesRepo = (file) => typeof file !== "string" || file === "" || leaves(file);
const leftRepo = (file) => `${file} leaves the repository: a ledger path is never read or written`;
// Inside the repository is not enough: a symlink in main's checkout (`link/board.md`, or its case twin
// `LINK/board.md` on a case-insensitive disk) can still point out. So a ledger path must also be one of
// the board's own files, as the board reads them (a board kept behind a symlink on purpose still is).
const notBoard = (file) => `${file} is not a board file: a ledger path is never read or written`;

/** Set the carried `cells` on the board under `dir` (main's checkout, or a scratch copy of its board)
 *  at the model level (`board-diff.cellEdits`): each that reads its `from` is set to its `to` through
 *  the board writer, all or nothing, and each that reads its `to` already is left. A cell that reads
 *  anything else is a conflict and nothing is written, unless `leave`: then it is left as it is and the
 *  rest are set. `{ ok, set, there, conflicts }`, or `{ ok: false, conflicts, reason? }`; a cell whose
 *  file leaves the repository refuses them all, nothing read or written. A cell whose file is not one
 *  of the board's files is a conflict (`now: null`) that is never written: the edit goes to the cell's
 *  own `file`, so a cell naming a real item but another file must not reach the writer. */
export function putCells(dir, spec, cells, { leave = false } = {}) {
  const out = cells.find((cell) => leavesRepo(cell.file));
  if (out) return { ok: false, set: [], there: [], conflicts: [], reason: leftRepo(out.file) };
  const board = workingBoard(dir, spec);
  const files = new Set(boardFiles(spec, board.model));
  const stray = cells.filter((cell) => !files.has(cell.file));
  const plan = cellEdits(
    spec,
    board,
    cells.filter((cell) => files.has(cell.file)),
  );
  const { set, there } = plan;
  const conflicts = [...plan.conflicts, ...stray.map((cell) => ({ ...cell, now: null }))];
  const why = stray.length > 0 ? { reason: notBoard(stray[0].file) } : {};
  if (conflicts.length > 0 && !leave) return { ok: false, set, there, conflicts, ...why };
  try {
    if (plan.edits.length > 0)
      applyAll(plan.edits.map(({ file, edit }) => ({ file: join(dir, file), edit })));
  } catch (error) {
    if (!(error instanceof WriteError)) throw error;
    return { ok: false, set, there, conflicts, reason: error.message };
  }
  return { ok: true, set, there, conflicts };
}

/** The working tree's board in the shape `board-diff` reads: `{ model, text(file) }`. */
export function workingBoard(root, spec) {
  const text = (file) => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch {
      return null;
    }
  };
  return { model: readProcess({ root, spec }), text };
}

/** HEAD's board (or `rev`'s) in the same shape: that commit's copy of each board file `model` (the
 *  working board's) was read from goes to a scratch directory and is read there, by the same reader. */
export function headBoard(root, spec, model, rev = "HEAD") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentry-head-")));
  const texts = new Map();
  try {
    for (const file of boardFiles(spec, model)) {
      const res = git(root, ["--literal-pathspecs", "cat-file", "blob", `${rev}:${file}`]);
      if (res.status !== 0) continue;
      texts.set(file, res.stdout);
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), res.stdout);
    }
    return { model: readProcess({ root: dir, spec }), text: (file) => texts.get(file) ?? null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The table rows `afterText` added to `beforeText`, when adding rows is all it did (every line of the
 *  first is still in the second, in order, and each added line is a row of a table): `[{ heading,
 *  header, idColumn, key, prev, text }]` in file order, `prev` the key of the row above it (null:
 *  first), or null when it did anything else. `idColumn(heading, header)` names the column that keys a
 *  row; the rows are found again by that key, so a neighbour changing its other cells does not matter. */
export function addedRows(beforeText, afterText, idColumn) {
  const [was, now] = [beforeText.split("\n"), afterText.split("\n")];
  const added = [];
  let i = 0;
  now.forEach((line, k) => {
    if (i < was.length && line === was[i]) i++;
    else added.push(k + 1);
  });
  if (i < was.length || added.length === 0) return null;
  const tables = md.tables(afterText);
  const rows = [];
  for (const n of added) {
    const table = tables.find((t) => t.rows.some((r) => r.line === n));
    if (!table) return null;
    const column = idColumn(table.heading, table.header) ?? table.header[0];
    const at = table.rows.findIndex((r) => r.line === n);
    const keyOf = (row) => md.plain(row.cells[column] ?? "");
    rows.push({
      heading: table.heading,
      header: table.header,
      idColumn: column,
      key: keyOf(table.rows[at]),
      prev: at === 0 ? null : keyOf(table.rows[at - 1]),
      text: now[n - 1],
    });
  }
  return rows;
}

// `text` with `row` inserted under the same table after the row its `prev` key names (right under the
// separator for the first), or as a conflict: `{ text }` or `{ conflict }`. A row already there is left.
function insertAdded(text, row) {
  const table = md
    .tables(text)
    .find(
      (t) => t.heading === row.heading && t.header.join("\u0000") === row.header.join("\u0000"),
    );
  if (!table) return { conflict: `no "${row.heading}" table like the one it was written in` };
  const keyOf = (r) => md.plain(r.cells[row.idColumn] ?? "");
  if (table.rows.some((r) => keyOf(r) === row.key)) return { text };
  let after = table.line + 1; // the separator
  if (row.prev !== null) {
    const above = table.rows.filter((r) => keyOf(r) === row.prev);
    if (above.length !== 1)
      return { conflict: `the row above ${row.key} (${row.prev}) is not there once` };
    after = above[0].line;
  }
  const lines = text.split("\n");
  lines.splice(after, 0, row.text);
  return { text: lines.join("\n") };
}

/** Put the added `rows` (`addedRows`, each with its `file`) back on the board files under `root` (the
 *  board `spec` reads), all or nothing: `{ ok, write() }` when every one has its place, else `{ ok:
 *  false, reason }`. Nothing is written until `write()`. A row whose file leaves the repository, or is
 *  not one of the board's files, refuses them all, nothing read. */
export function planRows(root, spec, rows) {
  const texts = new Map();
  const files =
    rows.length > 0 ? new Set(boardFiles(spec, readProcess({ root, spec }))) : new Set();
  for (const row of rows) {
    if (leavesRepo(row.file)) return { ok: false, reason: leftRepo(row.file) };
    if (!files.has(row.file)) return { ok: false, reason: notBoard(row.file) };
    let text = texts.get(row.file);
    if (text === undefined) {
      try {
        text = readFileSync(join(root, row.file), "utf8");
      } catch {
        return { ok: false, reason: `${row.file} cannot be read` };
      }
    }
    const put = insertAdded(text, row);
    if (put.conflict) return { ok: false, reason: `${row.file}: ${put.conflict}` };
    texts.set(row.file, put.text);
  }
  return {
    ok: true,
    write: () => {
      for (const [file, text] of texts) writeFileSync(join(root, file), text);
    },
  };
}
