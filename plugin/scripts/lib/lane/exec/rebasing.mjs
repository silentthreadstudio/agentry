// exec/rebasing — what a rebase of a lane's branch leaves: whether one is still in progress in its
// worktree, the range-diff kept in the run dir, and the base and the guard's start moved once it is done.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as ledgers from "../../process/ledger.mjs";
import { short } from "../fmt.mjs";
import { isAncestor, mergeBaseOf } from "../land.mjs";
import { git } from "../worktree.mjs";
import { moveStart } from "./guard/main-guard.mjs";

// Is a rebase still in progress in `worktree` (a conflict stopped it, or it was never continued)?
export function rebasing(worktree) {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const res = git(worktree, ["rev-parse", "--git-path", name]);
    if (res.status === 0 && existsSync(resolve(worktree, res.stdout.trim()))) return true;
  }
  return false;
}

// A range-diff line pairing an old commit with a new one: `1:  abc1234 = 1:  def5678 subject`, its mark
// `=` (the same patch), `!` (changed), `<` (dropped) or `>` (added).
const RANGE_PAIR = /^\s*(?:\d+|-+):\s+(?:[0-9a-f]+|-+)\s+([=!<>])\s/;

// A `git range-diff` result `res` kept as lane `id`'s `logs/range-diff-<n>.txt` (or why it failed):
// `{ file, changed }`, `changed` when a pair is not marked `=`, or git could not compute it.
export function keepRangeDiff(root, id, n, res) {
  const file = join(ledgers.runDir(root, id), "logs", `range-diff-${n}.txt`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    res.status === 0 ? res.stdout : `git range-diff failed: ${res.stderr.trim()}\n`,
  );
  const changed =
    res.status !== 0 ||
    res.stdout
      .split("\n")
      .some((line) => RANGE_PAIR.exec(line)?.[1] && RANGE_PAIR.exec(line)[1] !== "=");
  return { file, changed };
}

// The rebase the last `rebases[]` entry started, finished at `tip`: the base becomes the new merge base
// with main, and the range-diff of old base..old tip against new base..new tip goes to
// `logs/range-diff-<n>.txt`. The main guard's start moves to the new base, up to main's HEAD as the entry
// recorded it, and its snapshot with it (field 93): a path clean on main now whose content the commits
// from the old start to the new one changed was committed, so its start entry goes; a path still dirty,
// or clean with those commits leaving it as it was (its edit discarded), keeps its start, so it still
// trips. Changes `ledger` in place; returns `changed`.
export function finishRebase(root, ledger, tip) {
  const n = ledger.rebases.length;
  const entry = ledger.rebases[n - 1];
  const base = mergeBaseOf(root, ledger.mainBranch, tip);
  const res = base
    ? git(root, [
        "range-diff",
        "--no-color",
        `${entry.fromBase}..${entry.fromTip}`,
        `${base}..${tip}`,
      ])
    : { status: 1, stdout: "", stderr: `no merge base of ${ledger.mainBranch} and ${short(tip)}` };
  const { file, changed } = keepRangeDiff(root, ledger.id, n, res);
  Object.assign(entry, { toBase: base ?? entry.fromBase, toTip: tip, changed, rangeDiff: file });
  if (base) ledger.base = base;
  // The main commits the branch now sits on are its own history: the guard counts main's moves from there,
  // but never past main as the rebase was asked for, so a commit made on main during the round still counts.
  const asked = entry.mainHead;
  const to = base && asked ? (isAncestor(root, base, asked) ? base : asked) : null;
  if (to && ledger.mainAtStart?.head && isAncestor(root, ledger.mainAtStart.head, to))
    moveStart(root, ledger, to);
  return changed;
}
