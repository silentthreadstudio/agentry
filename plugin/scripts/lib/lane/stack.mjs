// stack — stacked lanes (A45): a lane cut from another lane's branch, `on: "<Y>"` in its ledger, with
// `base` Y's tip at the cut, so every `base..HEAD` reader measures only its own commits. What is due on
// it (`stackOf`), the lines a step prints for it, and the git of a restack: the guarded rebase onto Y's
// new tip or main, aborted on any stop so the branch, worktree and index are as they were.
//
// stackOf(root, ledger, all) -> { on, due: null | "parent" | "main" | "orphan", line, tip, state }
// gateRefusal(root, ledger, stack) -> string | null   why `exec gate` refuses a due stack
// chainOf(all, on) -> [id]                           the parent, its parent, …
// childrenOf(all, id) -> [id]                        the open lanes stacked on `id`, in id order
// unclean(worktree) -> [entry]                       `rebase in progress` first, then `git status`
// onTarget(root, { onto, base, tip }) -> boolean     the branch is on `onto` already (moved by hand)
// rebaseOnto(worktree, { onto, base, tip }) -> { ok } | { ok: false, stopped, subject, files, reason, restored }
//
// Every git call is one argv; a git refusal is an answer, not a throw. Node built-ins only.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prefix } from "../cli/invoke.mjs";
import { shellQuote as q } from "../text/shell.mjs";
import { short } from "./fmt.mjs";
import { commitOf, isAncestor, subjectOf } from "./land.mjs";
import { git, porcelain, rebaseInProgress, unmergedFiles } from "./worktree.mjs";

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "lane.mjs");

// A parent in one of these states leaves its child nothing to land after: the child is an orphan.
const ENDED = ["stopped", "closed"];
// A lane in one of these is no open child.
const DONE = ["merged", "closed", "stopped"];

/** `agentry lane exec restack <id> --root '<root>'`, `extra` after it. */
export const restackLine = (root, id, extra = "") =>
  `${prefix("lane", `node ${q(LANE)}`)} exec restack ${id} --root ${q(root)}${extra}`;

/** The lanes under `on`: the parent, the parent's parent, and so on (a loop ends it). */
export function chainOf(all, on) {
  const out = [];
  for (let id = on; id && !out.includes(id); id = all.find((l) => l.id === id)?.on) out.push(id);
  return out;
}

/** The open lanes (not merged, closed or stopped) stacked right on `id`, in id order. */
export const childrenOf = (all, id) =>
  all
    .filter((l) => l.on === id && !DONE.includes(l.state))
    .map((l) => l.id)
    .sort();

/**
 * What is due on a stacked lane: `parent` when its parent's branch tip is no longer its `base`, `main`
 * when the parent is merged, `orphan` when it is stopped, closed or gone (no ledger, no branch); null when
 * nothing is. `line` is what each step prints as `stack:` (null for a lane that is not stacked), `tip` the
 * parent's tip and `state` its state ("gone" for none).
 */
export function stackOf(root, ledger, all) {
  const on = ledger?.on;
  if (!on) return { on: null, due: null, line: null, tip: null, state: null };
  const parent = all.find((l) => l.id === on) ?? null;
  const tip = parent ? commitOf(root, `refs/heads/${parent.branch}`) : null;
  const state = parent?.state === "merged" ? "merged" : parent && tip ? parent.state : "gone";
  const due =
    state === "merged"
      ? "main"
      : state === "gone" || ENDED.includes(state)
        ? "orphan"
        : tip !== ledger.base
          ? "parent"
          : null;
  const id = ledger.id;
  const head = `on ${on} at ${short(ledger.base)}`;
  const tail = {
    parent: `${on} moved to ${short(tip)} → ${restackLine(root, id)}`,
    main: `${on} landed → ${restackLine(root, id)}`,
    orphan: `${on} is ${state}: ${id} lands only after it, or ${restackLine(root, id, " --main")} takes it off`,
  };
  return { on, due, line: due ? `${head}; ${tail[due]}` : head, tip, state };
}

/** Why `exec gate` refuses a stacked lane with something due (null when nothing is): its gate would not
 *  count, since the restack moves the tip. */
export function gateRefusal(root, ledger, { on, due, tip, state }) {
  if (!due) return null;
  const id = ledger.id;
  const wont = "a gate here would not count";
  if (due === "parent")
    return `${on} moved since ${id} was cut on it (${short(ledger.base)} → ${short(tip)}): ${wont} → ${restackLine(root, id)}`;
  if (due === "main")
    return `${on} landed since ${id} was cut on it: ${wont} → ${restackLine(root, id)}`;
  return `${on} is ${state} since ${id} was cut on it: ${wont}; ${id} lands only after it, or ${restackLine(root, id, " --main")} takes it off`;
}

/** What keeps a restack from starting in `worktree`: `rebase in progress` first when one is, then each
 *  `git status` entry. Empty when the worktree is clean. Throws when it is not a work tree. */
export const unclean = (worktree) => [
  ...(rebaseInProgress(worktree) ? ["rebase in progress"] : []),
  ...porcelain(worktree),
];

/** Is the branch at `tip` on `onto` already, moved there by hand (or by a restack killed before its
 *  ledger write): `onto` is an ancestor of the tip, and the old `base` is not, unless it is an ancestor of
 *  `onto` too (the parent only moved forward). `onto` that is the base itself moves nothing: not by hand. */
export const onTarget = (root, { onto, base, tip }) =>
  onto !== base &&
  isAncestor(root, onto, tip) &&
  (!isAncestor(root, base, tip) || isAncestor(root, base, onto));

// Config a repo may set that would let a rebase stash a dirty tree, squash `fixup!` commits or move other
// branches (a child's, cut from a commit in the range): all off, for this one call.
const REBASE = [
  "-c",
  "rebase.autoStash=false",
  "-c",
  "rebase.autoSquash=false",
  "-c",
  "rebase.updateRefs=false",
  "rebase",
];

/**
 * Rebase the branch checked out in `worktree` (at `tip`) from `base` onto `onto`, as one argv. On any stop
 * the rebase is aborted (`rebase --abort`, never a hand reset): `{ ok: false, stopped, subject, files,
 * reason, restored }`, `stopped` the commit it stopped on (null when git did not say), `files` the
 * conflicting paths, `restored` whether the branch is back at `tip` with a clean tree and no rebase left.
 */
export function rebaseOnto(worktree, { onto, base, tip }) {
  const res = git(worktree, [...REBASE, "--onto", onto, base]);
  if (res.status === 0) return { ok: true };
  const stopped = commitOf(worktree, "REBASE_HEAD");
  const files = unmergedFiles(worktree);
  const reason =
    (res.stderr || res.stdout).trim().split("\n")[0] || `git rebase exited ${res.status}`;
  git(worktree, ["rebase", "--abort"]); // nothing in progress (a bad ref) fails here, harmlessly
  let clean = false;
  try {
    clean = unclean(worktree).length === 0;
  } catch {} // not readable: not restored
  return {
    ok: false,
    stopped,
    subject: stopped ? subjectOf(worktree, stopped) : "",
    files,
    reason,
    restored: commitOf(worktree, "HEAD") === tip && clean,
  };
}
