// drift — work done outside Agentry's commands, found by comparing the worktrees, the ledgers, the board and
// main with each other (A35; plan R1b-6). No hook: `board status` asks every time. Two answers:
//
//   nudges(args)     -> [{ kind, id?, path?, branch?, command }]   what to flag, naming the command to use
//   mechanical(args) -> { fixes, left }                            what `board fix` may write, and what it only reports
// with args { root, runRoot, spec, model }: `root` is the checkout the board is read from (it may sit in a
// subfolder), `runRoot` the main checkout, where the ledgers live.
//
// A nudge kind: `unlisted-worktree` (an agent worktree no ledger knows or `lane spike` filed), `spike-for` (a
// worktree filed `--for` an item, until a ledger for it adopts or merges its branch), `spikes-unreadable`
// (`.agentry/run/spikes.json` is there but cannot be read), `started-by-hand` (a task the board
// has started and no ledger tracks), `merged-by-hand` (a branch whose work is on main with no merge record),
// `verified-not-merged` (verified, its work not on main yet), `episode-pending` (an episode payload nobody
// wrote) and `stale-status` (a hand status file still listing a finished task; one for the file). A task gets one nudge at most, in that order of precedence: merged-by-hand, verified-not-merged,
// episode-pending. Without a `lifecycle` the board has no started words, so `started-by-hand` stays quiet.
//
// Done is written only when provable (A23): a `lane merge` record that matches its branch, whose landed
// commits are still main's first-parent history right after the record's preHead, and whose change is
// still in effect on main's tip where it landed (`git.inEffect`: every line it added still there, every
// line it removed not back, by line history, not by matching text). Anything else is "unsure" and nothing
// is written. A hand merge (no record) is a nudge to `board fix --accept <id>`: the owner says it landed,
// and the commits on main that carry it must still be in effect the same way. Read-only; git goes
// through git.mjs, asked once per run for all the ledgers (`survey`, `records`), never once per ledger.
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { shellWord as w } from "../lane/adopt.mjs";
import { readSpikes, spikesFile } from "../lane/spikes.mjs";
import * as git from "./git.mjs";
import { kindOf } from "./ids.mjs";
import { isKept } from "./keep.mjs";
import * as ledgers from "./ledger.mjs";
import * as md from "./markdown.mjs";
import { readInside } from "./read.mjs";
import { commitsIn, handoffLines, namesCommits } from "./rules/evidence.mjs";
import { parentOf } from "./rules/structure.mjs";
import { own } from "./spec/shape.mjs";
import { lifecycleOf } from "./spec/workflow.mjs";
import { staleStatus } from "./stale-status.mjs";

const MERGED_STATES = ["merged", "closed"];
const SHA_TOKEN = /[0-9a-f]{7,40}/gi;

const workName = (spec) => spec.lifecycle?.kind;
const workItems = (spec, model) => {
  const name = workName(spec);
  return name ? (own(model.kinds, name)?.items ?? []) : [];
};

// ---- where a task's work stands on main ----

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

// Why the work `shas` carry is not in effect on `onto` now (`git.inEffect`, run by run), or null. `up`
// (each commit's parents) and `clear` (the runs `untouched` found) spare git calls asked for already.
function undone(root, shas, onto, { up = git.parents(root, shas), clear = new Set() } = {}) {
  for (const run of runs(shas, up)) {
    if (clear.has(runKey(run))) continue;
    const off = run.from ? git.inEffect(root, { ...run, onto }) : { what: "git" };
    if (off) return off;
  }
  return null;
}

// `git.inEffect`'s answer, in words.
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
function survey(root, onto, branches) {
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
const finished = (ledger) =>
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
function records(root, list, onto) {
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
function recorded(root, ledger, seen) {
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
const byHand = (root, ledger, onto, seen) =>
  ledger.branch
    ? landing(
        root,
        { branch: ledger.branch, onto, bases: [ledger.base, ledger.mainAtStart?.head] },
        seen,
      )
    : null;

// ---- the board, as written ----

// A field's text as written in the item's row (or frontmatter), or null when it cannot be read.
function written(root, spec, item, name) {
  const kind = spec.kinds[item.kind];
  const column = kind.fields[name]?.column;
  const text = readInside(root, join(root, spec.root, item.file));
  if (text === null || !column) return null;
  if (kind.at.table === undefined) return String(own(md.frontmatter(text)?.data, column) ?? "");
  const sec = md.section(text, kind.at.heading);
  const row = sec && md.tableIn(text, sec)?.rows.find((r) => r.line === item.line);
  return row ? md.plain(row.cells[column] ?? "") : null;
}

// The task's handoff lines in its parent's section (`handoffLines`: the bold leads naming it, the lines
// `done-has-handoff` reads) and the process file's `done-has-handoff` rules on that section. null when
// there is no such section to write to (the lifecycle refuses then).
function handoffOf(root, spec, model, item, target) {
  const section = target.slice("parent.file:".length);
  const parent = parentOf(model, item);
  const heading = parent?.own && own(spec.kinds[parent.kind].file?.sections, section)?.heading;
  const text = heading ? readInside(root, join(root, spec.root, parent.own.path)) : null;
  const sec = text === null ? null : md.section(text, heading);
  if (!sec) return null;
  const rules = spec.rules.filter(
    (r) => r.rule === "done-has-handoff" && r.kind === item.kind && r.section === section,
  );
  return { lines: handoffLines(md.boldLeads(text, sec), item.id), rules };
}

// Is the handoff there as `board check` will judge it: a line naming the task, which names its commit
// wherever a rule asks? `shasOf(rule)`: the commits that rule will read in the task's row.
const handedOff = ({ lines, rules }, shasOf) =>
  lines.length > 0 && rules.every((r) => namesCommits(lines, shasOf(r), r.commit ?? "none"));

// What the board lacks of the lifecycle's merged event for `item`: `need` (status, commit) and the
// hand-written state that stops a write: `status` (a status the lifecycle never sets before a merge) and
// `cell` (a commit cell that already holds text); `handoff` (see `handoffOf`) when the lifecycle writes one.
function gaps({ root, spec, model, item }) {
  const life = lifecycleOf(spec, item.kind) ?? spec.lifecycle; // the item's own kind's mapping
  const write = life.write ?? {};
  const need = [];
  const found = {};
  const merged = own(life.on, "merged");
  if (typeof own(write, "status") === "string" && typeof merged === "string") {
    const before = ["dispatched", "built", "failed"].map((e) => own(life.on, e));
    if (before.includes(item.status)) need.push("status");
    else if (item.status !== merged) found.status = item.status;
  }
  const field = own(write, "commit");
  if (typeof field === "string") {
    const cell = written(root, spec, item, field);
    if (cell === null) found.cell = "";
    else if (!cell.trim()) need.push("commit");
    else found.cell = cell.trim();
  }
  const target = own(write, "handoff");
  const handoff = typeof target === "string" ? handoffOf(root, spec, model, item, target) : null;
  return { need, field, handoff, ...found };
}

// What the board lacks of `item`'s merged event (`gaps`), or null when it has it all.
function lacking({ root, spec, model, item }) {
  const found = gaps({ root, spec, model, item });
  const { need, field, status, handoff } = found;
  const asWritten = (r) => commitsIn(item.fields[r.field ?? field]);
  const whole = !need.length && status === undefined && (!handoff || handedOff(handoff, asWritten));
  return whole ? null : found;
}

// One task whose work stands as `landed()` on main (`{ shas }` or `{ unsure }`, asked only when the board
// lacks something): the merged event `board fix` would apply (only the missing steps), or why it is only
// reported. Nothing when the board has it all.
function plan({ root, spec, model, item, landed }) {
  const lacks = lacking({ root, spec, model, item });
  if (!lacks) return {};
  const { need, field, status, cell, handoff } = lacks;
  const asWritten = (r) => commitsIn(item.fields[r.field ?? field]);
  const work = landed();
  if (work.unsure) return { left: `${item.id}: ${work.unsure}` };
  const short = work.shas[0].slice(0, 7);
  if (status !== undefined)
    return {
      left: `${item.id}: on main (${short}), but status "${status}" is set by hand; left alone`,
    };
  let shas = work.shas;
  if (cell !== undefined) {
    // A hand-written cell is never rewritten; the handoff then names the cell's first commit.
    const named = (cell.match(SHA_TOKEN) ?? []).map((t) =>
      work.shas.find((s) => s.startsWith(t.toLowerCase())),
    );
    if (!named.length || !named.every(Boolean))
      return {
        left: `${item.id}: ${field} cell "${cell}" is not the landed ${short}; left alone`,
      };
    shas = named;
  }
  // Once fix writes the commit cell, a rule reading that field reads the landed commits.
  const after = (r) => (cell === undefined && (r.field ?? field) === field ? shas : asWritten(r));
  const steps = handoff && !handedOff(handoff, after) ? [...need, "handoff"] : need;
  return steps.length ? { fixes: { id: item.id, shas, need: steps } } : {};
}

// ---- the two answers ----

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

// An agent's worktree: Agentry's own, a Claude Code agent's, or one on an agent-named branch. Never the
// checkout being read or the main one.
function isAgentTree(tree, { top, runRoot }) {
  if (samePath(tree.path, top) || samePath(tree.path, runRoot)) return false;
  const inRun = tree.path.startsWith(join(runRoot, ".agentry", "run", "worktrees") + sep);
  const inClaude = tree.path.includes(`${sep}.claude${sep}worktrees${sep}`);
  return inRun || inClaude || /^(agentry\/|worktree-agent-)/.test(tree.branch ?? "");
}

// The board task a worktree belongs to: an id that is a whole token of its branch or directory name.
function taskIdOf(tree, items) {
  const names = `${tree.branch ?? ""} ${basename(tree.path)}`.split(/[^A-Za-z0-9._-]+|\//);
  return items.map((i) => i.id).find((id) => names.includes(id));
}

const exec = (id) => `/agentry:exec ${id ?? "<id>"}`;
const merge = (id) => `/agentry:merge ${id ?? "<id>"}`;
const accept = (id) => `/agentry:board fix --accept ${id ?? "<id>"}`;
// Work merged by hand from a worktree no ledger knows: `--branch` adopts it (a ledger; merge then finds
// nothing left to land), and only then can the owner accept it.
const adopt = (id, branch) => `${merge(id)} --branch ${w(branch)}, then ${accept(id)}`;
// `path` as the main checkout `runRoot` reaches it, where the commands run: relative when inside it.
const shownPath = (runRoot, path) => {
  const rel = relative(runRoot, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
};
// Work in a worktree no ledger knows, for item `id` (branch `b`, null when unknown): land it as it is, or
// continue it in a lane (field 86). An orphan `agentry/<id>` is the branch a lane for `id` would cut, so
// it only lands. Real names are shell-quoted when they need it; the placeholders are not.
function landOrContinue(id, b) {
  const [i, br] = [id ?? "<id>", b ? w(b) : "<b>"];
  const land = `land: lane merge ${i} --branch ${br}`;
  return id && b === `agentry/${id}`
    ? land
    : `${land} · continue: lane exec adopt ${i} --branch ${br}`;
}
// An unlisted worktree not on main: those, file it (`lane spike`), or remove it (field 87). One whose HEAD
// is a spelling no branch is named (`git checkout WORKTREE-AGENT-X`) only removes: land, adopt and spike
// all refuse that spelling, so the row says how to make them take it.
function unlisted(tree, runRoot, id, tips) {
  const path = w(shownPath(runRoot, tree.path));
  if (tree.branch && !tips.has(tree.branch))
    return `remove: git worktree remove ${path} (it is on ${tree.branch}, which no branch is named: check it out by its exact name to land, continue or file it)`;
  return `${landOrContinue(id, tree.branch)} · file: lane spike ${tree.branch ? w(tree.branch) : path} --for ${id ?? "<id>"}|--keep "<why>" · remove: git worktree remove ${path}`;
}

// A ledger that took in `tree`'s branch or worktree: its own, or one it adopted (`lane exec adopt`).
const knows = (l, tree) =>
  l.worktree === tree.path ||
  (tree.branch && l.branch === tree.branch) ||
  (l.adopted &&
    (l.adopted.worktree === tree.path || (tree.branch && l.adopted.branch === tree.branch)));

// The agent worktrees no ledger knows. The checkout the board is in comes from its repository root: a board
// kept in a subfolder sees the worktrees too.
function unlistedTrees(root, runRoot, all) {
  const top = git.topLevel(root) || root;
  return git
    .worktrees(root)
    .filter((t) => isAgentTree(t, { top, runRoot }))
    .filter((t) => !all.some((l) => knows(l, t)));
}

// The spikes `lane spike` filed whose branch is still there (a gone one is left out): `{ spikes, error? }`,
// none and the reason when the file cannot be read.
function liveSpikes(runRoot, tips = git.branchTips(runRoot)) {
  const { spikes = [], error } = readSpikes(runRoot);
  return { spikes: spikes.filter((s) => tips.has(s.branch)), error };
}
const spikeOf = (spikes, tree) =>
  tree.branch ? spikes.find((s) => s.branch === tree.branch) : undefined;

/** The unlisted agent worktrees kept on purpose: the workflow file's `worktrees.keep`, and those filed
 *  `lane spike --keep`. Shown, never drift. */
export function keptTrees({ root, runRoot = root, spec }) {
  const spikes = liveSpikes(runRoot).spikes.filter((s) => typeof s.keep === "string");
  if (!spec.worktrees?.keep && !spikes.length) return [];
  return unlistedTrees(root, runRoot, ledgers.list(runRoot)).filter(
    (t) => isKept(spec, t) || spikeOf(spikes, t),
  );
}

export function nudges({ root, runRoot = root, spec, model }) {
  const life = spec.lifecycle;
  const items = workItems(spec, model);
  const all = ledgers.list(runRoot);
  const byId = new Map(all.map((l) => [l.id, l]));
  const onto = git.defaultBranch(root);
  const found = [];
  const tips = git.branchTips(runRoot);
  const { spikes, error: unreadable } = liveSpikes(runRoot, tips);
  // An unreadable spikes.json is said, not read as empty: its kept worktrees show as unlisted meanwhile.
  if (unreadable) {
    const file = shownPath(runRoot, spikesFile(runRoot));
    found.push({
      kind: "spikes-unreadable",
      path: file,
      command: `lane spike says why · fix or remove ${w(file)}`,
    });
  }
  const trees = unlistedTrees(root, runRoot, all).filter((t) => !isKept(spec, t));
  const loose = trees.filter((t) => !spikeOf(spikes, t));
  // Every branch whose landing is asked, surveyed in one go: git is asked per run, not per branch.
  const named = (t) => !t.branch || tips.has(t.branch);
  const asked = [
    ...loose.filter(named).map((t) => t.branch),
    ...all.filter((l) => !l.merge).map((l) => l.branch),
  ];
  const seen = survey(root, onto, asked.filter(Boolean));

  for (const tree of loose) {
    const id = taskIdOf(tree, items);
    const base = { ...(id ? { id } : {}), path: tree.path, branch: tree.branch ?? undefined };
    if (tree.branch && named(tree) && landing(root, { branch: tree.branch, onto }, seen))
      found.push({ kind: "merged-by-hand", ...base, command: adopt(id, tree.branch) });
    else
      found.push({
        kind: "unlisted-worktree",
        ...base,
        command: unlisted(tree, runRoot, id, tips),
      });
  }
  // A spike filed for an item: one row until a ledger for that item adopts or merges its branch.
  for (const s of spikes.filter((s) => typeof s.for === "string")) {
    const taken = all.some(
      (l) => l.id === s.for && (l.branch === s.branch || l.adopted?.branch === s.branch),
    );
    if (!taken)
      found.push({
        kind: "spike-for",
        id: s.for,
        path: s.path,
        branch: s.branch,
        command: landOrContinue(s.for, s.branch),
      });
  }

  for (const l of all) {
    const row = { id: l.id, ...(l.branch ? { branch: l.branch } : {}) };
    const work = l.merge ? null : byHand(root, l, onto, seen);
    if (work) {
      // On main with no merge record: a nudge only while the board has not caught up. Only the owner can
      // say it landed (`--accept`); fix never writes it on its own.
      const item = items.find((i) => i.id === l.id);
      const { fixes, left } = item
        ? plan({ root, spec, model, item, landed: () => work })
        : { left: true };
      if (fixes || left) found.push({ kind: "merged-by-hand", ...row, command: accept(l.id) });
    } else if (l.state === "verified" && !l.merge)
      found.push({ kind: "verified-not-merged", ...row, command: merge(l.id) });
    if (l.episode && !l.episode.writtenId)
      found.push({ kind: "episode-pending", ...row, command: "/agentry:close" });
  }

  const started = [life?.on?.dispatched, life?.on?.built].filter((w) => typeof w === "string");
  for (const item of items)
    if (started.includes(item.status) && !byId.has(item.id))
      found.push({ kind: "started-by-hand", id: item.id, command: exec(item.id) });

  const stale = staleStatus({ root, spec, model });
  if (stale) found.push(stale);

  // One nudge per task: the first one found for its id.
  const once = new Set();
  return found.filter((n) => !n.id || (!once.has(n.id) && once.add(n.id)));
}

// The one board item for `id` of `kind` (the lifecycle's by default), or why there is not one.
function itemFor(spec, model, id, kind = workName(spec)) {
  const here = (own(model.kinds, kind)?.items ?? []).filter((i) => i.id === id);
  return here.length === 1
    ? { item: here[0] }
    : { left: `${id}: on main, but ${here.length ? "several" : "no"} board items by that id` };
}

// A landed item of a runnable kind that is not the lifecycle's, lacking what its merged event writes:
// `board fix` applies the lifecycle kind only, so each gap is a line naming the command that sets it.
function unfixable(spec, item, { need }) {
  const write = lifecycleOf(spec, item.kind)?.write ?? {};
  return need.map((step) => {
    const field = step === "handoff" ? null : own(write, step);
    if (field === null || typeof field !== "string")
      return `${item.id} lacks its ${step}; board fix writes the ${workName(spec)} kind only`;
    return `${item.id} lacks its ${field} cell; board fix writes the ${workName(spec)} kind only → agentry board set ${item.kind} ${item.id} ${field}=… --apply`;
  });
}

/** What `board fix` may write (`fixes`: `{ id, shas, need }`, each the merged event's missing steps) and
 *  what it only reports (`left`: lines). A task is fixed only when it is provably on main: its ledger's
 *  `lane merge` record still holds there (`recorded`), and the board lacks the status, commit cell or
 *  handoff line (a bold lead naming it, as `done-has-handoff` reads it). A merge with no record is never
 *  written here (see `accepted`). Hand-written state is never overwritten: a status the lifecycle does
 *  not set before a merge, or a commit cell that does not name the landed commits, is reported instead.
 *  Main is asked only about a task whose board lacks something. */
export function mechanical({ root, runRoot = root, spec, model }) {
  const fixes = [];
  const left = [];
  if (!spec.lifecycle) return { fixes, left };
  const onto = git.defaultBranch(root);
  const list = ledgers
    .list(runRoot)
    .filter(finished)
    .map((ledger) => ({ ledger, ...itemFor(spec, model, ledger.id, kindOf(ledger, spec)) }));
  // Git is asked once for every record whose board lacks something (`landed` runs for those alone), not
  // once per record, and not at all when the board has every one.
  const proving = list.filter(({ item }) => item && lacking({ root, spec, model, item }));
  const seen = proving.length
    ? records(
        root,
        proving.map(({ ledger }) => ledger),
        onto,
      )
    : null;
  for (const { ledger, item, left: none } of list) {
    const landed = () => recorded(root, ledger, seen);
    const found = item ? plan({ root, spec, model, item, landed }) : { left: none };
    if (found.fixes && item.kind !== workName(spec))
      left.push(...unfixable(spec, item, found.fixes));
    else if (found.fixes) fixes.push(found.fixes);
    if (found.left) left.push(found.left);
  }
  return { fixes, left };
}

/** What `board fix --accept <id>` may write once the owner says task `id` was merged by hand: the same
 *  `{ fixes, left }` as `mechanical`, for that task alone. Its ledger's branch must be on main by git
 *  (`landing`: commits on main to name, still in effect on main's tip); otherwise nothing is written and
 *  the reason is in `left`. */
export function accepted({ root, runRoot = root, spec, model, id }) {
  if (!spec.lifecycle) return { fixes: [], left: [`${id}: the workflow file has no lifecycle`] };
  const ledger = ledgers.list(runRoot).find((l) => l.id === id);
  const { item, left: none } = itemFor(spec, model, id);
  const landed = () =>
    byHand(root, ledger, git.defaultBranch(root)) ?? {
      unsure: "its branch's change is not all on main as it was made; not accepted",
    };
  let found;
  if (!ledger?.branch) found = { left: `${id}: no ledger names its branch; nothing to accept` };
  else if (!item) found = { left: none };
  else found = plan({ root, spec, model, item, landed });
  return { fixes: found.fixes ? [found.fixes] : [], left: found.left ? [found.left] : [] };
}
