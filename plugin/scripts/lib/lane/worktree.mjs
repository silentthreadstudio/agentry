// worktree — the lane's git I/O for isolation (ADR-R2): Agentry creates the worktree and branch itself, on
// every host. `create` adds
// `agentry/<id>` under `<mainRoot>/.agentry/run/worktrees/<id>`; `remove` takes it down again, force-
// removing a locked worktree and deleting the branch (at its listed tip) only when nothing on it is
// missing from main.
//
// Unlike `process/git.mjs` (read-only, never throws), these calls change the repository, so a git failure
// throws an Error carrying git's own stderr. Node built-ins only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { idProblem } from "../id.mjs";
import { branchTips, defaultBranch, worktrees } from "../process/git.mjs";

/** Where the lane's worktrees live, under the main checkout. */
export const worktreesDir = (root) => join(root, ".agentry", "run", "worktrees");

/** The branch a task builds on. */
export const branchOf = (id) => `agentry/${id}`;

/** Run git in `dir`: `{ status, stdout, stderr }`, never throwing. No stdin unless `input` is given; a
 *  call still running after `timeout` ms (default 120 s) is killed and answers a non-zero status. */
export function git(dir, args, input, { timeout = 120_000 } = {}) {
  const res = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout,
    killSignal: "SIGKILL",
    detached: true, // its own process group, so a timeout can take down what git started
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error?.code === "ETIMEDOUT" && res.pid) {
    try {
      process.kill(-res.pid, "SIGKILL");
    } catch {} // the group is already gone
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function must(dir, args) {
  const res = git(dir, args);
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

export { idProblem };

/** Add worktree `<root>/.agentry/run/worktrees/<id>` on a new branch `agentry/<id>` cut from `base`.
 *  `root` is the main checkout. Throws on a bad id or any git failure (branch or path already exists). */
export function create(root, { id, base }) {
  const problem = idProblem(id);
  if (problem) throw new Error(problem);
  const path = join(worktreesDir(root), id);
  const branch = branchOf(id);
  mkdirSync(dirname(path), { recursive: true });
  must(root, ["worktree", "add", "-b", branch, path, base]);
  return { path, branch };
}

/** The path of the worktree that has `branch` checked out, or null. */
export function findByBranch(root, branch) {
  return worktrees(root).find((tree) => tree.branch === branch)?.path ?? null;
}

/** `git status` as `"XY path"` entries, untracked files listed one by one (never collapsed to a
 *  directory) and a rename as its delete and its add (`--no-renames`), so every path is its own entry.
 *  Empty when the tree is clean. Throws when `dir` is not a work tree. */
export function porcelain(dir) {
  // Not `must`: it trims, which would eat the leading space of the first entry (" M f" → "M f").
  const res = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  if (res.status !== 0) throw new Error(`git status: ${res.stderr.trim()}`);
  return res.stdout.split("\0").filter(Boolean);
}

/** Ignored files and directories in `dir` (a wholly ignored directory is one entry, `dir/`). */
export function ignoredFiles(dir) {
  const out = must(dir, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  return out.split("\0").filter(Boolean);
}

// True when all of `branch`'s work is on `onto`. Without merge commits, every commit outside `onto` must be
// patch-equivalent to one on it (`git cherry` marks that "-"). A branch holding a merge commit is judged by
// content instead: `git cherry` skips merges and, once `onto` is merged into the branch, can no longer see
// the commits the branch's were matched against. Every file the branch changed since the merge-base must be
// identical on `onto`. Anything unclear answers false, which keeps the branch.
function onMain(root, onto, branch) {
  const merges = git(root, ["rev-list", "--merges", `${onto}..${branch}`]);
  if (merges.status !== 0) return false;
  if (!merges.stdout.trim()) {
    const cherry = git(root, ["cherry", onto, branch]);
    return cherry.status === 0 && !cherry.stdout.split("\n").some((line) => line.startsWith("+"));
  }
  const base = git(root, ["merge-base", onto, branch]);
  if (base.status !== 0) return false;
  const touched = git(root, [
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    base.stdout.trim(),
    branch,
  ]);
  if (touched.status !== 0) return false;
  const files = touched.stdout.split("\0").filter(Boolean);
  if (files.length === 0) return true;
  return (
    git(root, ["--literal-pathspecs", "diff", "--quiet", onto, branch, "--", ...files]).status === 0
  );
}

function uncommitted(dir) {
  try {
    return porcelain(dir);
  } catch {
    return []; // not a work tree git can read: let `worktree remove` decide
  }
}

/** Remove the worktree at `path` and, when all the work on `branch` is on `onto` (default: the repo's
 *  default branch), delete the branch: by `update-ref -d` at the tip the branch list gives for its exact
 *  name, never `branch -D` or a read by name, which on a case-insensitive filesystem can open, and
 *  delete, another branch that differs only in case. A branch with such a twin is kept, saying so. A worktree with uncommitted changes is kept unless `force`; a locked
 *  one is taken down, and a locked one whose directory is gone is unlocked and pruned. A branch with
 *  unlanded work is kept. `reason` says why anything was kept. Never throws on a git failure: `removed`
 *  says it. */
export function remove(root, { path, branch, onto = defaultBranch(root), force = false }) {
  const out = { removed: false, branchDeleted: false };
  if (existsSync(path)) {
    const dirty = force ? [] : uncommitted(path);
    if (dirty.length > 0)
      return {
        ...out,
        reason: `${path} has uncommitted changes (${dirty.slice(0, 5).join(", ")}); commit them or pass force`,
      };
    const res = git(root, ["worktree", "remove", "-f", "-f", path]);
    if (res.status !== 0) return { ...out, reason: res.stderr.trim() };
  } else {
    git(root, ["worktree", "unlock", path]); // a locked entry is never pruned; failing here is fine
    git(root, ["worktree", "prune"]);
  }
  out.removed = !existsSync(path) && !worktrees(root).some((tree) => tree.path === path);
  if (!out.removed) return { ...out, reason: `${path} is still a registered worktree` };
  const tips = branch ? branchTips(root) : new Map();
  const tip = tips.get(branch);
  if (!tip) return out;
  const twin = [...tips.keys()].find(
    (b) => b !== branch && b.toLowerCase() === branch.toLowerCase(),
  );
  if (twin) return { ...out, reason: `${branch} has a case twin ${twin}: rename one first` };
  if (!onto) return { ...out, reason: "no main branch to compare against" };
  if (!onMain(root, onto, tip))
    return { ...out, reason: `${branch} has commits that are not on ${onto}` };
  out.branchDeleted = git(root, ["update-ref", "-d", `refs/heads/${branch}`, tip]).status === 0;
  return out;
}
