// adopt — the git reads of `lane exec adopt` (field 86): what a branch built outside exec holds for a lane
// to take in (its tip, its commits past main, the worktree it is checked out in and that worktree's
// uncommitted files, and the owner's calls noted on the spike filed for the lane's id on it), the refusals
// that leave nothing written, and the words the lane prints and briefs with. The branch and its worktree
// are only read, never moved: `exec/steps/adopt.mjs` opens the lane, picks the commits with `pickOnto`,
// carries the uncommitted work with `restart.mjs`'s `saveWork` and `carry`, and moves the calls into the
// ledger.
//
// source(root, { id, branch, base, mainBranch, lanes })
//   -> { branch, tip, commits, merges, worktree, dirty, calls } | { problem }
// pickOnto(worktree, { commits, diff }) -> { ok, conflict? }   cherry-pick the commits, merges left out
// adoptedWork(adopted) -> the round-1 brief's `## Adopted work` section
// cleanupSteps(adopted) -> the commands that remove the source once the lane has landed
// shellWord(text) -> text as one shell word: as it is when plain, else single-quoted
// shownName(text) -> text for a one-line message: JSON-escaped when empty or holding a control character
// resolveBranch(root, name, tips?) -> { branch, tip } | { problem, missing? }   one listed branch, exactly
// isBranch(root, name) -> whether `name` is a branch's own name, exactly: not a revision (`b~0`, `b@{0}`)
//                         nor another case of one
// strayTree(trees, branch, tips) -> the worktree on another spelling of `branch` that no branch is named
// unnamedHead(tree) -> the refusal for a worktree on a spelling no branch is named
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { branchTips, worktrees } from "../process/git.mjs";
import { shellQuote } from "./brief.mjs";
import { first, short } from "./fmt.mjs";
import { commitOf, filesOf, subjectOf } from "./land.mjs";
import { spikeCalls } from "./owner-calls.mjs";
import { git, porcelain } from "./worktree.mjs";

/** `text` as one shell word for a command a person or agent pastes: as it is when it holds only plain
 *  characters, else single-quoted (`brief.mjs`'s `shellQuote`). */
export const shellWord = (text) =>
  /^[\w./@%+=:,-]+$/.test(String(text)) ? String(text) : shellQuote(text);

/** `text` for a one-line message: as it is, or JSON-escaped when it is empty or holds a control
 *  character (a newline would split the line). */
export const shownName = (text) =>
  String(text) && !/\p{Cc}/u.test(String(text)) ? String(text) : JSON.stringify(String(text));

const folded = (name) => name.toLowerCase();

/** The local branch `name` is, resolved once from the branch list (`tips`: `branchTips`, read here when
 *  not given): `{ branch, tip }`, the tip from the listed line, never read again by name. `show-ref` and
 *  `rev-parse` read a loose ref's file, so on a case-insensitive filesystem `agentry/t2` opens the loose
 *  `agentry/T2`, even when a packed `agentry/t2` is listed too. `{ problem, missing }` when `name` is no
 *  valid branch name (`git check-ref-format`: `b~0`, `b@{0}` and `b^{commit}` are not) or no listed branch
 *  has it exactly; `{ problem }` when another listed branch has the same name in another case, whatever
 *  `core.ignorecase` says: one of the two would be read or deleted for the other. */
export function resolveBranch(root, name, tips = branchTips(root)) {
  const missing = { problem: `${shownName(name)} does not exist`, missing: true };
  const ref = `refs/heads/${name}`;
  if (!String(name) || String(name).startsWith("-")) return missing;
  if (git(root, ["check-ref-format", ref]).status !== 0) return missing;
  if (!tips.has(name)) return missing;
  const twin = [...tips.keys()].find((b) => b !== name && folded(b) === folded(name));
  if (twin) return { problem: `${name} has a case twin ${twin}: rename one first` };
  return { branch: name, tip: tips.get(name) };
}

/** Whether `name` is the name of a local branch, exactly as the branch list spells it. */
export const isBranch = (root, name) => resolveBranch(root, name).missing !== true;

/** The worktree of `trees` whose HEAD is another spelling of `branch` that no branch of `tips` is named
 *  (`git checkout WORKTREE-AGENT-X` on a case-insensitive filesystem writes that spelling into HEAD). */
export const strayTree = (trees, branch, tips) =>
  trees.find(
    (t) =>
      t.branch && t.branch !== branch && !tips.has(t.branch) && folded(t.branch) === folded(branch),
  );

/** The refusal for a worktree on a spelling no branch is named: its work cannot be told apart by name. */
export const unnamedHead = (tree) =>
  `${tree.path} is on ${tree.branch}, which no branch is named: check it out by its exact name`;

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
// the middle of (null: nothing). null when no worktree holds the branch; `{ problem }` when one is on
// another spelling of it that no branch of `tips` is named.
function treeOf(root, branch, tips) {
  const all = worktrees(root);
  const on = all.find((t) => t.branch === branch);
  if (on) return { path: on.path, op: midOp(on.path) };
  const stray = strayTree(all, branch, tips);
  if (stray) return { problem: unnamedHead(stray) };
  const heads = all
    .filter((t) => t.branch === null && existsSync(t.path))
    .map((t) => ({ path: t.path, branch: rebasing(t.path) }))
    .filter((t) => t.branch);
  const mid = heads.find((t) => t.branch === branch);
  if (mid) return { path: mid.path, op: "rebase" };
  const strayMid = strayTree(heads, branch, tips);
  return strayMid ? { problem: unnamedHead(strayMid) } : null;
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
 *  (null: none), that worktree's `git status` entries and the owner's calls of the spike filed for `id`
 *  on `branch` (`calls`, none when there is no such spike), which the new ledger takes in. `{ problem }`,
 *  one line, when there is nothing a lane may take in: no such branch, the main branch, a branch a ledger
 *  of `lanes` tracks (its own lane's, or one an open lane adopted), a worktree mid-rebase or mid-merge,
 *  no commits past main and a clean worktree, or a `spikes.json` that cannot be read (its calls would be
 *  lost). */
export function source(root, { id, branch, base, mainBranch, lanes = [] }) {
  // A revision that names a branch's commit (`b~0`) is no branch: its worktree and ledger would not match.
  // The tip is the listed one: read by name, a case twin's loose file could answer instead.
  const tips = branchTips(root);
  const named = resolveBranch(root, branch, tips);
  if (named.problem) return { problem: named.problem };
  const { tip } = named;
  if (branch === mainBranch) return { problem: `${branch} is the main branch: nothing to adopt` };
  const own = lanes.find((l) => l.branch === branch);
  if (own)
    return { problem: `${branch} is ${own.id}'s lane branch: use exec restart ${own.id} --carry` };
  const taken = lanes.find((l) => isOpen(l) && l.adopted?.branch === branch);
  if (taken) return { problem: `${branch} is already adopted by ${taken.id}` };
  const tree = treeOf(root, branch, tips);
  if (tree?.problem) return { problem: tree.problem };
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
  const { calls, problem } = spikeCalls(root, { id, branch });
  if (problem) return { problem };
  return { branch, tip, commits, merges, worktree: tree?.path ?? null, dirty, calls };
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

/** How to remove the adopted branch and its worktree once the lane has landed (adopt leaves both). The
 *  branch goes by `update-ref -d` with the tip adopt read: git refuses it when the ref holds anything else,
 *  where `git branch -D` could delete a case twin with it. */
export const cleanupSteps = ({ branch, tip, worktree }) => [
  ...(worktree ? [`git worktree remove ${shellWord(worktree)}`] : []),
  `git update-ref -d ${shellWord(`refs/heads/${branch}`)} ${tip}`,
];
