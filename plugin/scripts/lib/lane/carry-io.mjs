// carry-io — the I/O behind the carry of exec's uncommitted board writes (plan R1b-5): the patch and its
// sha256 the ledger keeps of them, the two boards (the working tree's and HEAD's) `board-diff` reads them
// against, and the board writes that put their cells back. `merge/carry.mjs` decides what may be
// carried; this only reads and writes. Every git call is an argv array; a refusal is `{ ok: false,
// reason }`, not a throw. The same patch holds the owner's `guard.allow` files (a new, untracked one as a
// new-file patch) and the files only `agentry board add` / `board set --apply` changed.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boardFiles, cellEdits } from "../process/board-diff.mjs";
import { contentOf } from "../process/board-writes.mjs";
import { readProcess } from "../process/read.mjs";
import { WriteError, applyAll } from "../process/write.mjs";
import { git } from "./worktree.mjs";

const first = (text) => text.trim().split("\n")[0] ?? "";

/** The sha256 of `text`, hex. */
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The uncommitted edits of `files` against HEAD as one binary patch, and its sha256: `{ patch,
 *  sha256 }`, or `{ error }` when git cannot say. */
export function uncommittedPatch(root, files) {
  const res = git(root, ["--literal-pathspecs", "diff", "--binary", "HEAD", "--", ...files]);
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
    const res = git(root, ["diff", "--no-index", "--binary", "--", "/dev/null", file]);
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

// The content ids (git's blob id, `:x` an executable, `:l` a symlink) of `files` as `commit` holds them,
// "-" for a file it lacks: the shape `board-writes.contentOf` gives for the working tree.
const MODE_SUFFIX = { 100755: ":x", 120000: ":l" };
function blobIds(root, commit, files) {
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
  const head = blobIds(root, "HEAD", files);
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

/** Set the carried `cells` on the board under `dir` (main's checkout, or a scratch copy of its board)
 *  at the model level (`board-diff.cellEdits`): each that reads its `from` is set to its `to` through
 *  the board writer, all or nothing, and each that reads its `to` already is left. A cell that reads
 *  anything else is a conflict and nothing is written, unless `leave`: then it is left as it is and the
 *  rest are set. `{ ok, set, there, conflicts }`, or `{ ok: false, conflicts, reason? }`. */
export function putCells(dir, spec, cells, { leave = false } = {}) {
  const plan = cellEdits(spec, workingBoard(dir, spec), cells);
  const { set, there, conflicts } = plan;
  if (conflicts.length > 0 && !leave) return { ok: false, set, there, conflicts };
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

/** HEAD's board in the same shape: HEAD's copy of each board file `model` (the working board's) was
 *  read from goes to a scratch directory and is read there, by the same reader. */
export function headBoard(root, spec, model) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentry-head-")));
  const texts = new Map();
  try {
    for (const file of boardFiles(spec, model)) {
      const res = git(root, ["--literal-pathspecs", "cat-file", "blob", `HEAD:${file}`]);
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
