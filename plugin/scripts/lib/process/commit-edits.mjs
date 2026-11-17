// commit-edits — `board add|set --apply --commit`: commit exactly the change a command makes, and nothing
// else that is uncommitted in the same files (a running lane's "doing" cell stays in the working tree).
// The command's edits are pure text functions, so they are replayed on each file's text at HEAD; that
// result is the committed blob. `planCommit` makes every refusal on the git side before the working tree is
// written; `commitPlan` stages the blobs (`hash-object -w` + `update-index --cacheinfo`) and runs
// `git commit -m` (hooks run, never `--no-verify`). Nothing is staged by this module unless `commitPlan`
// runs, and a failed commit puts the index for those files back to HEAD. Node built-ins and git.
//
// takeCommit(argv) -> { argv, commit, message }   `--commit ["<message>"]` taken out of argv
// planCommit(root, edits) -> plan                 throws WriteError (a refusal, nothing written)
// commitPlan(plan, message) -> sha                throws WriteError (commit failed, index restored)
import { existsSync, realpathSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { runGit } from "./git.mjs";
import { globMatch } from "./glob.mjs";
import { list } from "./ledger.mjs";
import { WriteError, applyAll } from "./write.mjs";

/** `--commit` and the message that may follow it (a next word that is not a flag) taken out of `argv`:
 *  `{ argv, commit, message }`, `message` null for the default. Put `--commit` last, so a positional word
 *  is not read as its message. */
export function takeCommit(argv) {
  const at = argv.indexOf("--commit");
  if (at < 0) return { argv, commit: false, message: null };
  const next = argv[at + 1];
  const named = typeof next === "string" && next !== "" && !next.startsWith("--");
  return {
    argv: argv.filter((_, i) => i !== at && !(named && i === at + 1)),
    commit: true,
    message: named ? next : null,
  };
}

// Git's operations that a commit would finish: a merge, cherry-pick or revert waiting for its commit
// (a clean index does not rule them out), a rebase or `am` in progress. The first one found, by name.
const REFS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
const DIRS = ["rebase-merge", "rebase-apply"];
function operationInProgress(top) {
  for (const ref of REFS)
    if (runGit(top, ["rev-parse", "-q", "--verify", ref]).status === 0) return ref;
  for (const dir of DIRS) {
    const at = runGit(top, ["rev-parse", "--git-path", dir]);
    if (at.status === 0 && existsSync(resolve(top, at.stdout.trim()))) return dir;
  }
  return null;
}

// Does an owned-files entry (a path, a directory, a glob, a bare file name, `path:lines`) cover `path`?
const owns = (entry, path) => {
  const e = entry
    .toLowerCase()
    .replace(/:[\d\s,–-]+$/, "")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  const p = path.toLowerCase();
  if (p === e || p.startsWith(`${e}/`) || globMatch([e], p)) return true;
  return !e.includes("/") && posix.basename(p) === e;
};

// The id of a running lane (not merged, cut or closed) whose owned files cover `path`, else null.
function laneOwning(root, path) {
  const running = list(root, { sweep: false }).filter(
    (l) => !["merged", "cut", "closed"].includes(l.state),
  );
  const hit = running.find((l) =>
    (l.owned ?? []).some((o) => owns(typeof o === "string" ? o : (o?.path ?? ""), path)),
  );
  return hit?.id ?? null;
}

const lines = (text) => text.split("\n").filter(Boolean);

/** What committing the change of `edits` (`[{ file, edit }]`, as `applyAll` takes them) would hold, after
 *  every refusal: `{ top, files: [{ path, mode, text }] }`, `path` relative to the git top level. Reads
 *  git and files, writes nothing. Throws `WriteError` when something is already staged, a file is not
 *  tracked at HEAD (or is a link), an edit fails on the working text (its own refusal), an edit cannot
 *  apply to HEAD's text (it needs uncommitted lines), or HEAD already holds the result. */
export function planCommit(root, edits) {
  const top = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw new WriteError("--commit needs a git repository; drop --commit");
  const topDir = realpathSync(top.stdout.trim());
  const staged = runGit(topDir, ["diff", "--cached", "--name-only"]);
  if (staged.status !== 0)
    throw new WriteError(`git could not read the index: ${staged.stderr.trim()}`);
  if (staged.stdout.trim())
    throw new WriteError(
      `${lines(staged.stdout).join(", ")} is already staged; commit or unstage it first, or drop --commit`,
    );
  const busy = operationInProgress(topDir);
  if (busy)
    throw new WriteError(
      `git has ${busy} in progress; finish or abort it first, or drop --commit (a commit would end it)`,
    );
  applyAll(edits, { preview: true }); // an edit that fails on the working text refuses as itself
  const byFile = new Map();
  for (const { file, edit } of edits) byFile.set(file, [...(byFile.get(file) ?? []), edit]);
  const files = [];
  for (const [file, steps] of byFile) {
    const path = relative(topDir, realpathSync(file)).split("\\").join("/");
    if (path.startsWith("..")) throw new WriteError(`${file} is outside the git repository`);
    const lane = laneOwning(root, path);
    if (lane)
      throw new WriteError(
        `lane ${lane} is running and owns ${path}: a commit on main would stop it; use plain --apply (its write is let through) and leave the commit to the land`,
      );
    const entry = runGit(topDir, ["ls-tree", "HEAD", "--", path]).stdout.trim();
    const [mode, type] = entry.split(/\s/);
    if (type !== "blob" || mode === "120000")
      throw new WriteError(
        `${path} is not a tracked file at HEAD; commit it first, or drop --commit`,
      );
    const head = runGit(topDir, ["show", `HEAD:${path}`]);
    if (head.status !== 0)
      throw new WriteError(`cannot read ${path} at HEAD: ${head.stderr.trim()}`);
    let text = head.stdout;
    try {
      for (const edit of steps) text = edit(text);
    } catch (error) {
      if (!(error instanceof WriteError)) throw error;
      throw new WriteError(
        `${path}: the edit needs lines that are not committed yet (${error.message}); commit those first, or drop --commit`,
      );
    }
    if (text !== head.stdout) files.push({ path, mode, text });
  }
  if (!files.length)
    throw new WriteError("HEAD already holds this change; there is nothing to commit");
  return { top: topDir, files };
}

/** Stage each planned blob and commit with `message`; the commit's full SHA. A failure (a hook, an
 *  identity git lacks) puts the index for these files back to HEAD and throws a `WriteError` that says the
 *  working-tree write stays. */
export function commitPlan({ top, files }, message) {
  const paths = files.map((f) => f.path);
  const undo = (why) => {
    const reset = runGit(top, ["reset", "-q", "HEAD", "--", ...paths]);
    const index =
      reset.status === 0
        ? `the index is back at HEAD for ${paths.join(", ")}`
        : `the index could not be put back (${reset.stderr.trim()}): run git reset -q HEAD -- ${paths.join(" ")}`;
    return new WriteError(`the working tree is written, but the commit failed (${why}); ${index}`);
  };
  for (const { path, mode, text } of files) {
    const blob = runGit(top, ["hash-object", "-w", "--stdin"], text);
    if (blob.status !== 0) throw undo(blob.stderr.trim());
    const put = runGit(top, [
      "update-index",
      "--cacheinfo",
      `${mode},${blob.stdout.trim()},${path}`,
    ]);
    if (put.status !== 0) throw undo(put.stderr.trim());
  }
  const done = runGit(top, ["commit", "-m", message]);
  if (done.status !== 0) throw undo((done.stderr || done.stdout).trim());
  return runGit(top, ["rev-parse", "HEAD"]).stdout.trim();
}
