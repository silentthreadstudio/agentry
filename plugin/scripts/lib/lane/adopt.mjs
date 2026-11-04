// adopt — the git reads of `lane exec adopt` (field 86): what a branch built outside exec holds for a lane
// to take in (its tip, its commits past main, the worktree it is checked out in and that worktree's
// uncommitted files), the refusals that leave nothing written, and the words the lane prints and briefs
// with. The branch and its worktree are only read, never moved: `cli/exec.mjs` cuts the lane, picks the
// commits with `pickOnto` and carries the uncommitted work with `restart.mjs`'s `saveWork` and `carry`.
//
// source(root, { branch, base, mainBranch, lanes }) -> { branch, tip, commits, merges, worktree, dirty }
//                                                    | { problem }
// pickOnto(worktree, { commits, diff }) -> { ok, conflict? }   cherry-pick the commits, merges left out
// adoptedWork(adopted) -> the round-1 brief's `## Adopted work` section
// cleanupSteps(adopted) -> the commands that remove the source once the lane has landed
// shellWord(text) -> text as one shell word: as it is when plain, else single-quoted
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { worktrees } from "../process/git.mjs";
import { shellQuote } from "./brief.mjs";
import { commitOf, filesOf, subjectOf } from "./land.mjs";
import { git, porcelain } from "./worktree.mjs";

const short = (sha) => String(sha ?? "").slice(0, 7);
const first = (text) => text.trim().split("\n")[0] ?? "";

/** `text` as one shell word for a command a person or agent pastes: as it is when it holds only plain
 *  characters, else single-quoted (`brief.mjs`'s `shellQuote`). */
export const shellWord = (text) =>
  /^[\w./@%+=:,-]+$/.test(String(text)) ? String(text) : shellQuote(text);

// The open lanes of `lanes` (ledgers): not merged or closed.
const isOpen = (l) => l.state !== "merged" && l.state !== "closed";

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

// The commits of `range` oldest first, `merges` only or none of them: `{ shas }` or `{ error }`.
function revList(root, range, merges) {
  const res = git(root, [
    "rev-list",
    "--reverse",
    merges ? "--merges" : "--no-merges",
    range,
    "--",
  ]);
  return res.status === 0
    ? { shas: res.stdout.split("\n").filter(Boolean) }
    : { error: first(res.stderr) };
}

/** What `branch` holds for the lane, read only: its tip, its commits past `base` (main's HEAD) oldest
 *  first as `{ sha, subject, files }`, merges left out (`merges`: those, as `{ sha, subject }`, never
 *  picked: a branch that merged main in holds main's commits already), the worktree it is checked out in
 *  (null: none) and that worktree's `git status` entries. `{ problem }`, one line, when there is nothing
 *  a lane may take in: no such branch, the main branch, a branch a ledger of `lanes` tracks (its own
 *  lane's, or one an open lane adopted), a worktree mid-rebase or mid-merge, or no commits past main and
 *  a clean worktree. */
export function source(root, { branch, base, mainBranch, lanes = [] }) {
  const tip = branch.startsWith("-") ? null : commitOf(root, `refs/heads/${branch}`);
  if (!tip) return { problem: `${branch} does not exist` };
  if (branch === mainBranch) return { problem: `${branch} is the main branch: nothing to adopt` };
  const own = lanes.find((l) => l.branch === branch);
  if (own)
    return { problem: `${branch} is ${own.id}'s lane branch: use exec restart ${own.id} --carry` };
  const taken = lanes.find((l) => isOpen(l) && l.adopted?.branch === branch);
  if (taken) return { problem: `${branch} is already adopted by ${taken.id}` };
  const tree = treeOf(root, branch);
  if (tree?.op)
    return {
      problem: `the worktree of ${branch} (${tree.path}) is mid-${tree.op}: finish or abort it, then adopt`,
    };
  const [picks, merged] = [false, true].map((m) => revList(root, `${base}..${tip}`, m));
  const failed = picks.error ?? merged.error;
  if (failed !== undefined)
    return { problem: `git rev-list ${short(base)}..${branch} failed: ${failed}` };
  const commits = picks.shas.map((sha) => ({
    sha,
    subject: subjectOf(root, sha),
    files: filesOf(root, sha) ?? [],
  }));
  const merges = merged.shas.map((sha) => ({ sha, subject: subjectOf(root, sha) }));
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
  return { branch, tip, commits, merges, worktree: tree?.path ?? null, dirty };
}

/** Cherry-pick `commits` (oldest first, no merges) onto the lane's worktree. `{ ok: true }`, or on a stop
 *  `{ ok: false, conflict }` naming it as `carry` does, with the next step: `<sha> <subject> conflicts in
 *  <files>: resolve it, git cherry-pick --continue[, then git apply --3way <diff>]`. `diff`: the saved
 *  uncommitted work still to apply after the picks, or null. */
export function pickOnto(worktree, { commits, diff }) {
  if (!commits.length) return { ok: true };
  const picked = git(worktree, [
    "cherry-pick",
    "--allow-empty",
    "--keep-redundant-commits",
    ...commits.map((c) => c.sha),
  ]);
  if (picked.status === 0) return { ok: true };
  const stopped = commitOf(worktree, "CHERRY_PICK_HEAD");
  const files = git(worktree, ["diff", "--name-only", "--diff-filter=U", "-z"])
    .stdout.split("\0")
    .filter(Boolean);
  const what = stopped ? `${short(stopped)} ${subjectOf(worktree, stopped)}` : "the cherry-pick";
  const then = diff ? `, then git apply --3way ${shellWord(diff)}` : "";
  return {
    ok: false,
    conflict: files.length
      ? `${what} conflicts in ${files.join(", ")}: resolve it, git cherry-pick --continue${then}`
      : `${what} stopped: ${first(picked.stderr || picked.stdout)}: finish it (git cherry-pick --continue or --skip)${then}`,
  };
}

/** The `## Adopted work` section of the lane's first brief: the commits taken in from the branch, already
 *  on the lane, and what to do with them; the uncommitted files as `carry` left them, and its stop. */
export function adoptedWork({
  branch,
  tip,
  commits,
  merges = [],
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
      : String(conflict ?? "").includes(`git apply --3way ${shellWord(diff)}`)
        ? ` Its worktree's ${files} uncommitted file(s) are not in the tree yet.`
        : ` Its worktree's ${files} uncommitted file(s) are not in the tree yet: once the pick is done, apply them with \`git apply --3way ${shellWord(diff)}\`.`;
  const stop = conflict ? ` Resolve this first: ${conflict}.` : "";
  // A merge is never picked: what its own resolution changed is not on the lane.
  const skipped = merges.length
    ? ` Its ${merges.length} merge commit(s) (${merges.map((m) => `${short(m.sha)} ${m.subject}`).join("; ")}) were not picked: whatever a merge resolved by hand is not on the lane, so compare it with \`git diff ${short(tip)} HEAD\`.`
    : "";
  return [
    "## Adopted work",
    "",
    `This lane adopted ${branch} at ${short(tip)}${from}, built outside exec. Its commits are already on the lane:`,
    "",
    ...list,
    "",
    `Check them against the contract, fix what the owner asked, and do not redo them.${skipped}${staged}${stop}`,
    "",
  ].join("\n");
}

/** How to remove the adopted branch and its worktree once the lane has landed (adopt leaves both). */
export const cleanupSteps = ({ branch, worktree }) => [
  ...(worktree ? [`git worktree remove ${shellWord(worktree)}`] : []),
  `git branch -D ${shellWord(branch)}`,
];
