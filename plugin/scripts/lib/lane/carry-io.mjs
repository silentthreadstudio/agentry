// carry-io — the I/O behind the carry of exec's uncommitted board writes (plan R1b-5): the patch that
// sets them aside and puts them back, its sha256, and the two boards (the working tree's and HEAD's)
// `board-diff` reads them against. `merge/carry.mjs` decides what may be carried; this only reads and
// writes. Every git call is an argv array; a refusal is `{ ok: false, reason }`, not a throw.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boardFiles } from "../process/board-diff.mjs";
import { readProcess } from "../process/read.mjs";
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

/** Apply `patch` to the working tree, all or nothing; `check` only asks git whether it would, and
 *  `reverse` takes it off (a reverse check that passes: the edits are on the tree already);
 *  `directory` (relative to `root`, the git root) applies it to the copy of the files under it. `{ ok }`
 *  or `{ ok: false, reason }`. */
export function applyPatch(root, patch, { check = false, reverse = false, directory } = {}) {
  const flags = [
    ...(check ? ["--check"] : []),
    ...(reverse ? ["--reverse"] : []),
    ...(directory ? [`--directory=${directory}`] : []),
  ];
  const res = git(root, ["apply", "--whitespace=nowarn", ...flags, "-"], patch);
  return res.status === 0
    ? { ok: true }
    : { ok: false, reason: first(res.stderr) || "git apply failed" };
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
