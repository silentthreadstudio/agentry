// worktree — the lane's git I/O for isolation (ADR-R2): Agentry creates the worktree and branch itself, on
// every host. `mainRoot` resolves any directory (a worktree included) to the main checkout; `create` adds
// `agentry/<id>` under `<mainRoot>/.agentry/run/worktrees/<id>`; `remove` takes it down again, force-
// removing a locked worktree and deleting the branch only when nothing on it is missing from main.
//
// Unlike `process/git.mjs` (read-only, never throws), these calls change the repository, so a git failure
// throws an Error carrying git's own stderr. Node built-ins only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultBranch, worktrees } from "../process/git.mjs";

/** Where the lane's worktrees live, under the main checkout. */
export const worktreesDir = (root) => join(root, ".agentry", "run", "worktrees");

/** The branch a task builds on. */
export const branchOf = (id) => `agentry/${id}`;

/** Run git in `dir`: `{ status, stdout, stderr }`, never throwing. */
export function git(dir, args, input) {
  const res = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function must(dir, args) {
  const res = git(dir, args);
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

/** The main checkout for `dir`, which may be inside a linked worktree. Null outside a repository. */
export function mainRoot(dir) {
  const res = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return res.status === 0 ? dirname(res.stdout.trim()) : null;
}

// An id becomes a directory name and a branch name: plain characters only, and none of the sequences git
// refuses in a ref (`..`, `.lock`) or that could climb out of the worktrees directory.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function idProblem(id) {
  if (typeof id !== "string" || !ID.test(id)) return `id "${id}" must match ${ID}`;
  if (id.includes("..")) return `id "${id}" must not contain ".."`;
  if (id.includes(".lock")) return `id "${id}" must not contain ".lock"`;
  if (id.endsWith(".")) return `id "${id}" must not end with "."`;
  return null;
}

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
 *  directory). Empty when the tree is clean. Throws when `dir` is not a work tree. */
export function porcelain(dir) {
  const out = must(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const parts = out.split("\0").filter(Boolean);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    entries.push(parts[i]);
    if (/^[RC]/.test(parts[i])) i++; // a rename or copy carries its source as the next field
  }
  return entries;
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

// True when every commit on `branch` is already on `onto`, by ancestry or by patch id (`git cherry`
// marks a commit "-" when an equivalent one is upstream, "+" when it is not).
function onMain(root, onto, branch) {
  const res = git(root, ["cherry", onto, branch]);
  return res.status === 0 && !res.stdout.split("\n").some((line) => line.startsWith("+"));
}

/** Remove the worktree at `path` (force twice, which also takes down a locked one) and, when every commit
 *  on `branch` is on `onto` (default: the repo's default branch), delete the branch. A branch with
 *  unlanded commits is kept and `reason` says so. Never throws on a git failure: `removed` says it. */
export function remove(root, { path, branch, onto = defaultBranch(root) }) {
  const out = { removed: false, branchDeleted: false };
  if (existsSync(path)) {
    const res = git(root, ["worktree", "remove", "-f", "-f", path]);
    if (res.status !== 0) return { ...out, reason: res.stderr.trim() };
  } else {
    git(root, ["worktree", "prune"]);
  }
  out.removed = !existsSync(path);
  if (
    !branch ||
    git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status !== 0
  )
    return out;
  if (!onto) return { ...out, reason: "no main branch to compare against" };
  if (!onMain(root, onto, branch))
    return { ...out, reason: `${branch} has commits that are not on ${onto}` };
  out.branchDeleted = git(root, ["branch", "-D", branch]).status === 0;
  return out;
}
