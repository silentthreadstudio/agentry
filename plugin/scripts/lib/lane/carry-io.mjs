// carry-io — the I/O behind the carry of exec's uncommitted board writes (plan R1b-5): the patch and its
// sha256 the ledger keeps of them, the two boards (the working tree's and HEAD's) `board-diff` reads them
// against, and the board writes that put their cells back. `merge/carry.mjs` decides what may be
// carried; this only reads and writes. Every git call is an argv array; a refusal is `{ ok: false,
// reason }`, not a throw.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boardFiles, cellEdits } from "../process/board-diff.mjs";
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
