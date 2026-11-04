// adopt — the git reads of `lane exec adopt` (field 86): what a branch built outside exec holds for a lane
// to take in (its tip, its commits past main, the worktree it is checked out in and that worktree's
// uncommitted files), the refusals that leave nothing written, and the words the lane prints and briefs
// with. The branch and its worktree are only read, never moved: `cli/exec.mjs` cuts the lane and carries
// the work with `restart.mjs`'s `saveWork` and `carry`.
//
// source(root, { branch, base, mainBranch }) -> { branch, tip, commits, worktree, dirty } | { problem }
// adoptedWork(adopted) -> the round-1 brief's `## Adopted work` section
// cleanupSteps(adopted) -> the commands that remove the source once the lane has landed
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { worktrees } from "../process/git.mjs";
import { commitOf, filesOf, subjectOf } from "./land.mjs";
import { git, porcelain } from "./worktree.mjs";

const short = (sha) => String(sha ?? "").slice(0, 7);

// The git-path `name` of the worktree at `dir` when it is there, else null.
function gitPathIn(dir, name) {
  const res = git(dir, ["rev-parse", "--git-path", name]);
  const path = res.status === 0 ? resolve(dir, res.stdout.trim()) : null;
  return path && existsSync(path) ? path : null;
}

// What the worktree at `dir` is in the middle of, or null: a rebase, a merge or a cherry-pick.
function midOp(dir) {
  if (gitPathIn(dir, "rebase-merge") || gitPathIn(dir, "rebase-apply")) return "rebase";
  if (gitPathIn(dir, "MERGE_HEAD")) return "merge";
  if (gitPathIn(dir, "CHERRY_PICK_HEAD")) return "cherry-pick";
  return null;
}

// The branch a rebase in the worktree at `dir` works on (its HEAD is detached meanwhile), or null.
function rebasing(dir) {
  for (const name of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
    const file = gitPathIn(dir, name);
    if (file)
      return readFileSync(file, "utf8")
        .trim()
        .replace(/^refs\/heads\//, "");
  }
  return null;
}

// The worktree `branch` is checked out in, or the one rebasing it: `{ path, op }`, `op` what it is in
// the middle of (null: nothing). null when no worktree holds the branch.
function treeOf(root, branch) {
  const all = worktrees(root);
  const on = all.find((t) => t.branch === branch);
  if (on) return { path: on.path, op: midOp(on.path) };
  const mid = all.find(
    (t) => t.branch === null && existsSync(t.path) && rebasing(t.path) === branch,
  );
  return mid ? { path: mid.path, op: "rebase" } : null;
}

/** What `branch` holds for the lane, read only: its tip, its commits past `base` (main's HEAD) oldest
 *  first as `{ sha, subject, files }`, the worktree it is checked out in (null: none) and that worktree's
 *  `git status` entries. `{ problem }`, one line, when there is nothing a lane may take in: no such
 *  branch, the main branch, a lane's own branch, a worktree mid-rebase or mid-merge, or no commits past
 *  main and a clean worktree. */
export function source(root, { branch, base, mainBranch }) {
  const tip = branch.startsWith("-") ? null : commitOf(root, `refs/heads/${branch}`);
  if (!tip) return { problem: `${branch} does not exist` };
  if (branch === mainBranch) return { problem: `${branch} is the main branch: nothing to adopt` };
  if (branch.startsWith("agentry/"))
    return { problem: `${branch} is a lane's branch: use exec restart --carry` };
  const tree = treeOf(root, branch);
  if (tree?.op)
    return {
      problem: `the worktree of ${branch} (${tree.path}) is mid-${tree.op}: finish or abort it, then adopt`,
    };
  const listed = git(root, ["rev-list", "--reverse", `${base}..${tip}`, "--"]);
  if (listed.status !== 0)
    return { problem: `git rev-list ${short(base)}..${branch} failed: ${listed.stderr.trim()}` };
  const commits = listed.stdout
    .split("\n")
    .filter(Boolean)
    .map((sha) => ({ sha, subject: subjectOf(root, sha), files: filesOf(root, sha) ?? [] }));
  let dirty = [];
  if (tree)
    try {
      dirty = porcelain(tree.path);
    } catch (e) {
      return { problem: `the worktree of ${branch} (${tree.path}) cannot be read: ${e.message}` };
    }
  if (!commits.length && !dirty.length)
    return {
      problem: `nothing to adopt: use exec start (${branch} has no commits past main${tree ? " and its worktree is clean" : ""})`,
    };
  return { branch, tip, commits, worktree: tree?.path ?? null, dirty };
}

/** The `## Adopted work` section of the lane's first brief: the commits taken in from the branch, already
 *  on the lane, and what to do with them; the uncommitted files as `carry` left them, and its stop. */
export function adoptedWork({
  branch,
  tip,
  commits,
  worktree,
  files = 0,
  applied,
  diff,
  conflict,
}) {
  const list = commits.length
    ? commits.map((c) => `- ${short(c.sha)} ${c.subject}`)
    : ["- none: only uncommitted work"];
  const from = worktree ? ` (checked out at ${worktree})` : "";
  const staged = !files
    ? ""
    : applied
      ? ` Its worktree's ${files} uncommitted file(s) are applied staged: \`git diff --cached\` shows them.`
      : String(conflict ?? "").includes(`git apply --3way ${diff}`)
        ? ` Its worktree's ${files} uncommitted file(s) are not in the tree yet.`
        : ` Its worktree's ${files} uncommitted file(s) are not in the tree yet: once the pick is done, apply them with \`git apply --3way ${diff}\`.`;
  const stop = conflict ? ` Resolve this first: ${conflict}.` : "";
  return [
    "## Adopted work",
    "",
    `This lane adopted ${branch} at ${short(tip)}${from}, built outside exec. Its commits are already on the lane:`,
    "",
    ...list,
    "",
    `Check them against the contract, fix what the owner asked, and do not redo them.${staged}${stop}`,
    "",
  ].join("\n");
}

/** How to remove the adopted branch and its worktree once the lane has landed (adopt leaves both). */
export const cleanupSteps = ({ branch, worktree }) => [
  ...(worktree ? [`git worktree remove ${worktree}`] : []),
  `git branch -D ${branch}`,
];
