// restart — the git and file work of `lane exec restart` (field 69): what the old lane leaves (its tip, its
// uncommitted diff, the ignored files a removal would delete), the archive of its ledger and run files under
// the first free number, the old worktree taken down and its branch kept as `agentry/<id>.<n>`, and the carry
// of its work into the new worktree. `cli/exec.mjs` runs the checks, the order and the new lane's start.
//
// leftover(ledger, disposable) -> { ignored, tip, commits } | { problem }   read only
// saveWork(worktree, file) -> { files } | { error }      the uncommitted diff (untracked files too) to `file`
// archiveNumber(root, id) -> n                           the first number no archive or kept branch holds
// archive(root, id, n) -> { runs, ledger }               the ledger and run dir moved to `<id>.<n>`
// retire(root, ledger, n) -> { kept: branch | null, tip }   worktree removed, branch renamed `agentry/<id>.<n>`
// carry(worktree, { base, tip, diff }) -> { ok, conflict? }   cherry-pick base..tip (none when the range is
//                                                         empty), then `git apply --3way`
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { branchTips } from "../process/git.mjs";
import { resolveBranch, shellWord } from "./adopt.mjs";
import { applyPatch, asidePatch } from "./carry-io.mjs";
import { commitOf, currentBranch, disposableMatcher, subjectOf } from "./land.mjs";
import { branchOf, git, ignoredFiles, porcelain, remove } from "./worktree.mjs";

const short = (sha) => String(sha ?? "").slice(0, 7);
const first = (text) => text.trim().split("\n")[0] ?? "";
const processDir = (root) => join(root, ".agentry", "run", "process");
const unmerged = (dir) =>
  git(dir, ["diff", "--name-only", "--diff-filter=U", "-z"]).stdout.split("\0").filter(Boolean);
// Does `dir` hold a file at any depth (a link counts as one)? Unreadable answers yes: it stays counted.
function holdsFile(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (e) => !e.isDirectory() || holdsFile(join(dir, e.name)),
    );
  } catch {
    return true;
  }
}

/** What the old lane leaves behind, read only: its branch tip (null when the branch is gone), the commits
 *  past its base, and the ignored files in its worktree that `cleanup.disposable` (and the defaults) do not
 *  cover, which a removal would delete. An empty directory (or one holding only empty ones) is no file: it
 *  never counts, and the removal takes it. `{ problem }` when its worktree is mid-rebase or off its branch. */
export function leftover(root, ledger, disposable = []) {
  const tip = commitOf(root, `refs/heads/${ledger.branch}`);
  const count = tip ? git(root, ["rev-list", "--count", `${ledger.base}..${tip}`]) : null;
  const commits = count?.status === 0 ? Number(count.stdout.trim()) : 0;
  if (!existsSync(ledger.worktree)) return { ignored: [], tip, commits };
  if (currentBranch(ledger.worktree) !== ledger.branch)
    return {
      problem: `the worktree ${ledger.worktree} is not on ${ledger.branch} (a rebase or pick in progress?): finish or abort it, then restart`,
    };
  let found = [];
  try {
    found = ignoredFiles(ledger.worktree);
  } catch {} // no work tree git can read: nothing to lose
  const kept = disposableMatcher(disposable);
  const lost = (entry) => !entry.endsWith("/") || holdsFile(join(ledger.worktree, entry));
  return { ignored: found.filter((entry) => lost(entry) && !kept(entry)), tip, commits };
}

/** The worktree's uncommitted work against its HEAD (staged, unstaged and untracked) as one binary patch,
 *  written to `file` byte for byte; `{ files }` the paths it holds, `{ error }` when git cannot say. */
export function saveWork(worktree, file) {
  let entries;
  try {
    entries = porcelain(worktree);
  } catch (e) {
    return { error: e.message };
  }
  const files = [...new Set(entries.map((e) => e.slice(3)))];
  const untracked = entries.filter((e) => e.startsWith("?? ")).map((e) => e.slice(3));
  const made = files.length ? asidePatch(worktree, files, untracked) : { patch: "" };
  if (made.error) return { error: made.error };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, made.patch, "latin1");
  return { files };
}

/** The archive number for lane `id`: one past the highest `runs/<id>.<k>`, `ledger/<id>.<k>.json` or
 *  `agentry/<id>.<k>` branch, so an archive never overwrites an older one. */
export function archiveNumber(root, id) {
  const of = (names, suffix = "") =>
    names
      .filter((n) => n.startsWith(`${id}.`) && n.endsWith(suffix))
      .map((n) => n.slice(id.length + 1, n.length - suffix.length))
      .filter((k) => /^\d+$/.test(k))
      .map(Number);
  const list = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const branches = git(root, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/agentry/"])
    .stdout.split("\n")
    .filter(Boolean)
    .map((b) => b.replace(/^agentry\//, ""));
  const taken = [
    ...of(list(join(processDir(root), "runs"))),
    ...of(list(join(processDir(root), "ledger")), ".json"),
    ...of(branches),
  ];
  return Math.max(0, ...taken) + 1;
}

/** Move lane `id`'s ledger to `ledger/<id>.<n>.json` and its run dir to `runs/<id>.<n>/`: `{ runs, ledger }`,
 *  the archived paths. Throws when either target exists (never overwritten). */
export function archive(root, id, n) {
  const ledger = join(processDir(root), "ledger", `${id}.${n}.json`);
  const runs = join(processDir(root), "runs", `${id}.${n}`);
  if (existsSync(ledger) || existsSync(runs)) throw new Error(`an archive ${id}.${n} exists`);
  const from = join(processDir(root), "runs", id);
  if (existsSync(from)) renameSync(from, runs);
  else mkdirSync(runs, { recursive: true });
  renameSync(join(processDir(root), "ledger", `${id}.json`), ledger);
  return { runs, ledger };
}

/** Take down the old lane's worktree (its uncommitted work saved, its ignored files checked by `leftover`)
 *  and keep its branch as `agentry/<id>.<n>`: `{ kept, tip }`, the kept branch and its tip, or `{ kept:
 *  null }` when no listed branch has the lane's exact name. The tip is the listed one (`resolveBranch`),
 *  and the rename is `update-ref` of the new ref at that tip (refused when it exists) then `update-ref -d`
 *  of the old one at it, never `branch -m` or a read by name: on a case-insensitive filesystem those can
 *  open, and move, another branch that differs only in case. Throws when either name has a case twin
 *  (looked for again between the two steps: a twin at the same sha would pass the delete's old-value
 *  check and go with it), or when git refuses. */
export function retire(root, ledger, n) {
  const res = remove(root, { path: ledger.worktree, branch: null, force: true });
  if (!res.removed)
    throw new Error(`the worktree ${ledger.worktree} was not removed: ${res.reason}`);
  const tips = branchTips(root);
  const named = resolveBranch(root, ledger.branch, tips);
  if (named.missing) return { kept: null };
  if (named.problem) throw new Error(named.problem);
  const { tip } = named;
  const kept = branchOf(`${ledger.id}.${n}`);
  const clash = [...tips.keys()].find((b) => b.toLowerCase() === kept.toLowerCase());
  if (clash) throw new Error(`${clash} would be a case twin of ${kept}: rename it first`);
  const run = (args) => {
    const moved = git(root, args);
    if (moved.status !== 0)
      throw new Error(`git ${args.map(shellWord).join(" ")}: ${first(moved.stderr)}`);
  };
  run(["update-ref", `refs/heads/${kept}`, tip, ""]);
  const still = resolveBranch(root, ledger.branch);
  if (still.problem && !still.missing) throw new Error(still.problem);
  if (still.tip !== tip) throw new Error(`${ledger.branch} moved off ${tip} during the restart`);
  run(["update-ref", "-d", `refs/heads/${ledger.branch}`, tip]);
  return { kept, tip };
}

/** Carry the old branch's work into `worktree`: cherry-pick `base..tip` (oldest first; a branch with no
 *  commits past its base has nothing to pick), then apply the saved uncommitted diff with `git apply --3way`. `{ ok: true, applied }`, or on the first stop `{ ok:
 *  false, applied, conflict }`, the stop named (`<sha> <subject> conflicts in <files>` or `the uncommitted
 *  diff conflicts in <files>`) with the conflict left in the worktree for the builder. `applied`: the diff
 *  is in the tree (staged, its own conflicts marked); a pick that stopped leaves it still to apply. */
export function carry(worktree, { base, tip, diff }) {
  // git refuses an empty range ("empty commit set passed"): only uncommitted work goes straight to the diff.
  const count = tip ? git(worktree, ["rev-list", "--count", `${base}..${tip}`]) : null;
  if (tip && !(count.status === 0 && count.stdout.trim() === "0")) {
    const picked = git(worktree, [
      "cherry-pick",
      "--allow-empty",
      "--keep-redundant-commits",
      `${base}..${tip}`,
    ]);
    if (picked.status !== 0) {
      const stopped = commitOf(worktree, "CHERRY_PICK_HEAD");
      const files = unmerged(worktree);
      const what = stopped
        ? `${short(stopped)} ${subjectOf(worktree, stopped)}`
        : "the cherry-pick";
      return {
        ok: false,
        applied: false,
        conflict: files.length
          ? `${what} conflicts in ${files.join(", ")}: resolve it, git cherry-pick --continue, then git apply --3way ${diff}`
          : `${what} stopped: ${first(picked.stderr || picked.stdout)}`,
      };
    }
  }
  const patch = existsSync(diff) ? readFileSync(diff, "latin1") : "";
  if (!patch) return { ok: true, applied: false };
  const applied = applyPatch(worktree, patch, "--3way");
  if (applied.status === 0) return { ok: true, applied: true };
  const files = unmerged(worktree);
  return {
    ok: false,
    applied: files.length > 0,
    conflict: files.length
      ? `the uncommitted diff conflicts in ${files.join(", ")}: resolve the markers`
      : `the uncommitted diff did not apply (${first(applied.stderr)}): it is at ${diff}`,
  };
}
