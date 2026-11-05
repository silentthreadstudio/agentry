// landing — where a branch's work stands on main, proven from git alone: its own commits (`ownCommits`),
// how they were picked onto main (`picks`, `survey`), whether their change is still in effect on main's
// tip (`undone`, by `inEffect`), and a `lane merge` record checked the same way (`records`,
// `recorded`). Read-only; git is asked once per run for all the branches and ledgers, never once per
// branch.
//
//   survey(root, onto, branches)             -> what git says about many branches at once
//   landing(root, { branch, onto, bases }, seen?) -> { shas } | { unsure } | null   a branch's work on main
//   records(root, list, onto)                -> what git says about many finished ledgers at once
//   recorded(root, ledger, seen)             -> { shas } | { unsure }   a ledger's record, proven now
//   byHand(root, ledger, onto, seen?)        -> a ledger's hand merge, by its branch alone
//   finished(ledger)                         -> whether a ledger has landed commits to prove
import * as git from "./git.mjs";
import { inEffect } from "./in-effect.mjs";

const MERGED_STATES = ["merged", "closed"];

// A reflog entry that made the commit on the branch itself (not a reset or a fast-forward): a commit, a
// pick, a revert, or a merge of main into the branch.
const MADE =
  /^(commit( \((amend|initial|merge)\))?|cherry-pick|revert): |^merge [^:]+: Merge made by /;

// The commits made on `branch` itself, oldest first, merges left out (a merge of main into it carries no
// work of its own), once its tip is on main (merge-base is then the tip): `<base>..<tip>` for the first of
// `bases` (the ledger's) that is a proper ancestor, else the commits its reflog says were made on it. When
// the reflog does not show the tip made there (a branch reset or fast-forwarded to main, or never
// committed to), it has no work of its own: null. undefined when nothing tells.
function ownCommits(root, { tip, branch, bases }) {
  const entries = git.reflog(root, branch).map((e) => ({ sha: e.sha, made: MADE.test(e.says) }));
  if (entries.length && !(entries[0].sha === tip && entries[0].made)) return null;
  const base = bases
    .map((ref) => git.commitOf(root, ref))
    .find((c) => c && c !== tip && git.isAncestor(root, c, tip));
  if (base) return git.commits(root, `${base}..${tip}`, { firstParent: true, noMerges: true });
  if (!entries.length) return undefined;
  const made = [...new Set(entries.filter((e) => e.made).map((e) => e.sha))].reverse();
  const up = git.parents(root, made);
  return made.filter((sha) => up.get(sha)?.length === 1 && git.isAncestor(root, sha, tip));
}

// `shas` (commits on main, oldest first) as runs in which each commit's parent is the one before it: a
// run's net change is one diff, `from..to` (`from`: its first commit's parent). A gap (someone else's
// commit between two picks, a merge of main into the branch) starts a new run, so what the gap did to the
// task's lines is checked too. `up`: each commit's parents.
function runs(shas, up) {
  const out = [];
  for (const sha of shas) {
    const last = out.at(-1);
    if (last && up.get(sha)?.[0] === last.to) last.to = sha;
    else out.push({ from: up.get(sha)?.[0], to: sha });
  }
  return out;
}
const runKey = ({ from, to }) => `${from}..${to}`;

// The runs of `list` that nothing has touched on `onto` since: no file one changed differs between its
// `to` (on `onto`'s history) and `onto`, mode or blob, from one `diff-tree` for them all. Such a run is
// in effect byte for byte, so `undone` need not ask `inEffect` about it. A Set of `runKey`s.
function untouched(root, list, onto) {
  const todo = list.filter((run) => run.from && run.to !== onto);
  const pairs = todo.flatMap(({ from, to }) => [
    [to, from],
    [onto, to],
  ]);
  const paths = pairs.length ? git.changedPaths(root, pairs) : [];
  const clear = (_, i) => paths && ![...paths[2 * i]].some((path) => paths[2 * i + 1].has(path));
  return new Set(todo.filter(clear).map(runKey));
}

// Why the work `shas` carry is not in effect on `onto` now (`inEffect`, run by run), or null. `up`
// (each commit's parents) and `clear` (the runs `untouched` found) spare git calls asked for already.
function undone(root, shas, onto, { up = git.parents(root, shas), clear = new Set() } = {}) {
  for (const run of runs(shas, up)) {
    if (clear.has(runKey(run))) continue;
    const off = run.from ? inEffect(root, { ...run, onto }) : { what: "git" };
    if (off) return off;
  }
  return null;
}

// `inEffect`'s answer, in words.
function said({ file, line, what }) {
  const at = line ? `${file}:${line}` : file;
  if (what === "added") return `the line it added at ${at} is not there now (reverted or changed?)`;
  if (what === "removed") return `a line it removed from ${file} is back (reverted?)`;
  if (what === "around") return `the lines around its change at ${at} were edited since`;
  if (what === "file") return `${file} is not as it landed`;
  return "git cannot tell whether its change is still there";
}

// ---- what git says about many branches at once ----

// The commits of `graph` (Map sha → parents) reachable from `start` without leaving it.
function reach(graph, start) {
  const seen = new Set();
  for (const todo = [start]; todo.length; ) {
    const sha = todo.pop();
    if (seen.has(sha) || !graph.has(sha)) continue;
    seen.add(sha);
    todo.push(...graph.get(sha));
  }
  return seen;
}

// The best common ancestor of main (`onMain`: what it reaches) and a branch (`mine`) in `graph`: a common
// commit that is no other common commit's parent; `base` (an ancestor of both, below the graph) when they
// share nothing in it; undefined when that leaves several (a criss-cross, for git to settle).
function forkOf(graph, onMain, mine, base) {
  const common = [...mine].filter((sha) => onMain.has(sha));
  if (!common.length) return base;
  const shared = new Set(common);
  const below = new Set(common.flatMap((sha) => graph.get(sha).filter((p) => shared.has(p))));
  const best = common.filter((sha) => !below.has(sha));
  return best.length === 1 ? best[0] : undefined;
}

// How `branches` ([name, tip]: tips not on main) were picked onto `main`, read from one graph and one
// patch-id pass over all of them: Map name → { mine, theirs, fork, tip, up, squash }, `mine` the patch
// ids of the branch's own commits (oldest first), `theirs` main's commits since the fork by patch id (the
// newest of each), `up` the graph (each commit's parents), `squash` whether a branch not all picked could
// still be on main (`squashable`). A branch with no history in common with main is left out.
function picks(root, main, branches) {
  const found = new Map();
  const base = branches.length && git.octopusBase(root, [main, ...branches.map(([, t]) => t)]);
  if (!base) {
    // Some branch shares no history with main: ask branch by branch, so only that one is left out.
    if (branches.length > 1)
      for (const branch of branches) for (const e of picks(root, main, [branch])) found.set(...e);
    return found;
  }
  const heads = [main, ...branches.map(([, tip]) => tip)];
  const graph = git.graph(root, heads, base);
  const ids = new Map(git.patchIds(root, [...heads, `^${base}`]).map((p) => [p.sha, p.patchId]));
  const order = [...graph.keys()].filter((sha) => ids.has(sha)); // newest first, no merges
  const onMain = reach(graph, main);
  for (const [name, tip] of branches) {
    const mine = reach(graph, tip);
    const theirs = new Map();
    for (const sha of order.filter((s) => onMain.has(s) && !mine.has(s)))
      if (!theirs.has(ids.get(sha))) theirs.set(ids.get(sha), sha);
    const own = order.filter((s) => mine.has(s) && !onMain.has(s)).map((s) => ids.get(s));
    const fork = forkOf(graph, onMain, mine, base) ?? git.mergeBase(root, main, tip);
    found.set(name, { mine: own.reverse(), theirs, fork, tip, up: graph });
  }
  const unpicked = [...found.values()].filter(
    (p) => p.fork && !p.mine.every((id) => p.theirs.has(id)),
  );
  const could = squashable(root, main, unpicked);
  for (const [i, p] of unpicked.entries()) p.squash = could[i];
  return found;
}

// For each of `picks` (with a `fork` and a `tip`): could its change `fork..tip` be on `main` though no
// commit there matches its own (a squash)? Only when main changed, since the fork, a file the branch
// changed: else main's copy of each of them is the fork's and the change is not there. One `diff-tree`
// for all of them; true for each when git cannot answer.
function squashable(root, main, picks) {
  const pairs = picks.flatMap(({ fork, tip }) => [
    [tip, fork],
    [main, fork],
  ]);
  const paths = pairs.length ? git.changedPaths(root, pairs) : [];
  return picks.map((_, i) => {
    if (!paths) return true;
    const [branch, since] = [paths[2 * i], paths[2 * i + 1]];
    return [...branch].some((path) => since.has(path));
  });
}

// Main's commits for a branch every commit of which was picked (`picks`), oldest first; else undefined.
const pickedOnto = ({ mine, theirs }) => {
  const shas = mine.map((id) => theirs.get(id));
  return shas.every(Boolean) ? shas : undefined;
};

// What `landing` asks git about `branches` landing on `onto`, asked once for all of them: every local
// branch's tip, main's, which tips are on main already, how the others were picked (`picks`) and which of
// those picks nothing touched since (`untouched`). A branch that is gone, or on main, costs nothing more.
export function survey(root, onto, branches) {
  const tips = git.branchTips(root);
  const main = tips.get(onto) ?? git.commitOf(root, onto);
  const on = main ? git.branchTips(root, { on: main }) : new Map();
  const off = [...new Set(branches)].filter((b) => b !== onto && tips.has(b) && !on.has(b));
  const picked = main
    ? picks(
        root,
        main,
        off.map((b) => [b, tips.get(b)]),
      )
    : new Map();
  const landed = [...picked.values()].flatMap((p) => {
    const shas = p.mine.length ? pickedOnto(p) : undefined;
    return shas ? runs(shas, p.up) : [];
  });
  return { tips, main, on, picked, clear: untouched(root, landed, main) };
}

/** Where `branch`'s work stands on `onto` now, from git alone (no merge record): `{ shas }`, the commits on
 *  main that carry it (oldest first), while their change is still in effect on main's tip (`undone`), so
 *  a revert, a reset or a hand edit that took any of its lines out leaves it off; `{ unsure }` when no
 *  commits on main can be named for it (a squash that looks applied; a tip on main with no reflog or base
 *  to tell its own commits); null when it is not on main. `bases` are refs the branch may have been cut
 *  from (the ledger's `base`). `seen` is a `survey` that covers the branch (one is made when not given). */
export function landing(root, { branch, onto, bases = [] }, seen = survey(root, onto, [branch])) {
  const tip = seen.tips.get(branch);
  const { main } = seen;
  if (!tip || !main || branch === onto) return null;
  if (seen.on.has(branch)) {
    // Merged (--no-ff) or fast-forwarded: the branch's own commits are main's.
    const shas = ownCommits(root, { tip, branch, bases });
    if (shas === undefined)
      return { unsure: "its tip is on main, but not which commits are its own" };
    if (!shas?.length) return null;
    return undone(root, shas, main) ? null : { shas };
  }
  // Cherry-picked: every commit of the branch has a commit on main with its patch id (the newest one).
  const pick = seen.picked.get(branch);
  if (!pick?.mine.length) return null;
  const shas = pickedOnto(pick);
  // No commit to name (a squash): whether its text looks applied only picks the nudge; nothing is ever
  // written for an unsure, so the offset-tolerant `reverseApplies` is enough for that.
  if (!shas)
    return pick.squash && git.reverseApplies(root, { from: pick.fork, to: tip, onto: main })
      ? { unsure: "on main, but no commit there matches its own (squashed?)" }
      : null;
  return undone(root, shas, main, { up: pick.up, clear: seen.clear }) ? null : { shas };
}

// A ledger whose `lane merge` finished: it has landed commits to prove.
export const finished = (ledger) =>
  MERGED_STATES.includes(ledger.state) &&
  Array.isArray(ledger.merge?.landed) &&
  ledger.merge.landed.length > 0;

// The refs a merge record names (a `planned` that is not a list names none).
const named = ({ branch, merge: m }) =>
  [m.preHead, m.tip, ...m.landed, ...(Array.isArray(m.planned) ? m.planned : [])]
    .concat(`refs/heads/${branch}`)
    .filter((ref) => typeof ref === "string");

/** What `recorded` asks git about the finished ledgers `list` against `onto`, asked once for them all:
 *  the commit each ref their records name is (`full`), main's tip, the commits' parents (`up`) and
 *  identities (`ids`), main's first-parent commits after each `preHead` (`chain`, from one walk down to
 *  the oldest of them) and the landed runs nothing touched since (`clear`, see `untouched`). */
export function records(root, list, onto) {
  const at = git.commitsOf(root, [onto, ...list.flatMap(named)]);
  const full = (ref) => (typeof ref === "string" ? (at.get(ref) ?? null) : null);
  const main = full(onto);
  const shas = [...new Set(at.values())];
  const up = git.parents(root, shas);
  const ids = git.identities(root, shas);
  const froms = [...new Set(list.map((l) => full(l.merge.preHead)).filter(Boolean))];
  const base = main && froms.length ? git.octopusBase(root, froms) : null;
  const line = base ? git.commits(root, `${base}..${main}`, { firstParent: true }) : [];
  // A `preHead` on that walk: the commits after it are `git rev-list --first-parent preHead..main`.
  const chain = (from) => {
    const i = from === base ? -1 : line.indexOf(from);
    if (from === base || i >= 0) return line.slice(i + 1);
    return git.commits(root, `${from}..${main}`, { firstParent: true });
  };
  const landed = list.flatMap((l) => {
    const shas = l.merge.landed.map(full);
    return shas.every(Boolean) ? runs(shas, up) : [];
  });
  return { full, main, up, ids, chain, clear: main ? untouched(root, landed, main) : new Set() };
}

// Is the merge record about this ledger's branch? `merge.planned` (what the land picked) must be the
// branch's own commits up to its tip, in order, each one's parent the one before, and each landed commit
// the planned one at its place, with the same author, date and message (a cherry-pick keeps them). The tip
// is the branch's ref while it lives, else the tip the record wrote at the land. `seen`: `records`.
function ofBranch(ledger, landed, { full, up, ids }) {
  const { planned, tip } = ledger.merge;
  if (!Array.isArray(planned) || planned.length !== landed.length) return false;
  const picks = planned.map(full);
  const end = full(`refs/heads/${ledger.branch}`) ?? full(tip);
  if (!end || !picks.every(Boolean) || picks.at(-1) !== end) return false;
  const chained = picks.every(
    (s, i) => up.get(s)?.length === 1 && (i === 0 || up.get(s)[0] === picks[i - 1]),
  );
  return chained && picks.every((s, i) => ids.has(s) && ids.get(s) === ids.get(landed[i]));
}

// A finished ledger's `lane merge` record, proven against main now: `{ shas }` while its landed commits
// are main's first-parent commits right after its `preHead`, in order, the record is about the ledger's
// branch (`ofBranch`), and their change is still in effect on main's tip (`undone`); else `{ unsure }`.
// `seen`: `records` for a list that holds this ledger.
export function recorded(root, ledger, seen) {
  const { full, main } = seen;
  const shas = ledger.merge.landed.map(full);
  const from = full(ledger.merge.preHead);
  const chain = main && from ? seen.chain(from) : [];
  if (!shas.every((sha, i) => sha && chain[i] === sha))
    return { unsure: "merged, but those commits are no longer main's history (reset?)" };
  if (!ofBranch(ledger, shas, seen))
    return { unsure: "merged, but its merge record does not match its branch's commits" };
  const off = undone(root, shas, main, seen);
  return off ? { unsure: `merged, but ${said(off)}` } : { shas };
}

// A ledger's hand merge, by its branch alone (`seen`: a `survey` that covers it, when one was made).
export const byHand = (root, ledger, onto, seen) =>
  ledger.branch
    ? landing(
        root,
        { branch: ledger.branch, onto, bases: [ledger.base, ledger.mainAtStart?.head] },
        seen,
      )
    : null;
