// drift — work done outside Agentry's commands, found by comparing the worktrees, the ledgers, the board and
// main with each other (A35; plan R1b-6). No hook: `board status` asks every time. Two answers:
//
//   nudges(args)     -> [{ kind, id?, path?, branch?, command }]   what to flag, naming the command to use
//   mechanical(args) -> { fixes, left }                            what `board fix` may write, and what it only reports
// with args { root, runRoot, spec, model }: `root` is the checkout the board is read from (it may sit in a
// subfolder), `runRoot` the main checkout, where the ledgers live.
//
// A nudge kind: `unlisted-worktree` (an agent worktree no ledger knows), `started-by-hand` (a task the board
// has started and no ledger tracks), `merged-by-hand` (a branch whose work is on main with no merge record),
// `verified-not-merged` (verified, its work not on main yet) and `episode-pending` (an episode payload nobody
// wrote). A task gets one nudge at most, in that order of precedence: merged-by-hand, verified-not-merged,
// episode-pending. Without a `lifecycle` the board has no started words, so `started-by-hand` stays quiet.
//
// Done is written only when provable (A23): a `lane merge` record that matches its branch, whose landed
// commits are still main's first-parent history right after the record's preHead, and whose change is
// still in effect on main's tip where it landed (`git.inEffect`: every line it added still there, every
// line it removed not back, by line history, not by matching text). Anything else is "unsure" and nothing
// is written. A hand merge (no record) is a nudge to `board fix --accept <id>`: the owner says it landed,
// and the commits on main that carry it must still be in effect the same way. Read-only; git goes
// through git.mjs.
import { realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import * as git from "./git.mjs";
import * as ledgers from "./ledger.mjs";
import * as md from "./markdown.mjs";
import { readInside } from "./read.mjs";
import { commitsIn, handoffLines, namesCommits } from "./rules/evidence.mjs";
import { parentOf } from "./rules/structure.mjs";
import { own } from "./spec.mjs";

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
// task's lines is checked too.
function runs(root, shas) {
  const up = git.parents(root, shas);
  const out = [];
  for (const sha of shas) {
    const last = out.at(-1);
    if (last && up.get(sha)?.[0] === last.to) last.to = sha;
    else out.push({ from: up.get(sha)?.[0], to: sha });
  }
  return out;
}

// Why the work `shas` carry is not in effect on `onto` now (`git.inEffect`, run by run), or null.
function undone(root, shas, onto) {
  for (const run of runs(root, shas)) {
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

/** Where `branch`'s work stands on `onto` now, from git alone (no merge record): `{ shas }`, the commits on
 *  main that carry it (oldest first), while their change is still in effect on main's tip (`undone`), so
 *  a revert, a reset or a hand edit that took any of its lines out leaves it off; `{ unsure }` when no
 *  commits on main can be named for it (a squash that looks applied; a tip on main with no reflog or base
 *  to tell its own commits); null when it is not on main. `bases` are refs the branch may have been cut
 *  from (the ledger's `base`). */
export function landing(root, { branch, onto, bases = [] }) {
  const tip = git.commitOf(root, branch);
  const main = git.commitOf(root, onto);
  if (!tip || !main || branch === onto) return null;
  let shas;
  if (git.isAncestor(root, tip, main)) {
    // Merged (--no-ff) or fast-forwarded: the branch's own commits are main's.
    shas = ownCommits(root, { tip, branch, bases });
    if (shas === undefined)
      return { unsure: "its tip is on main, but not which commits are its own" };
    if (!shas?.length) return null;
  } else {
    // Cherry-picked: every commit of the branch has a commit on main with its patch id (the newest one).
    const fork = git.mergeBase(root, main, tip);
    const mine = fork ? git.patchIds(root, `${main}..${tip}`) : [];
    if (!mine.length) return null;
    const theirs = new Map();
    for (const p of git.patchIds(root, `${tip}..${main}`))
      if (!theirs.has(p.patchId)) theirs.set(p.patchId, p.sha);
    shas = mine.map((p) => theirs.get(p.patchId)).reverse();
    // No commit to name (a squash): whether its text looks applied only picks the nudge; nothing is ever
    // written for an unsure, so the offset-tolerant `reverseApplies` is enough for that.
    if (!shas.every(Boolean))
      return git.reverseApplies(root, { from: fork, to: tip, onto: main })
        ? { unsure: "on main, but no commit there matches its own (squashed?)" }
        : null;
  }
  return undone(root, shas, main) ? null : { shas };
}

// A ledger whose `lane merge` finished: it has landed commits to prove.
const finished = (ledger) =>
  MERGED_STATES.includes(ledger.state) &&
  Array.isArray(ledger.merge?.landed) &&
  ledger.merge.landed.length > 0;

const full = (root, ref) => (typeof ref === "string" ? git.commitOf(root, ref) : null);

// Is the merge record about this ledger's branch? `merge.planned` (what the land picked) must be the
// branch's own commits up to its tip, in order, each one's parent the one before, and each landed commit
// the planned one at its place, with the same author, date and message (a cherry-pick keeps them). The tip
// is the branch's ref while it lives, else the tip the record wrote at the land.
function ofBranch(root, ledger, landed) {
  const { planned, tip } = ledger.merge;
  if (!Array.isArray(planned) || planned.length !== landed.length) return false;
  const picks = planned.map((s) => full(root, s));
  const end = full(root, `refs/heads/${ledger.branch}`) ?? full(root, tip);
  if (!end || !picks.every(Boolean) || picks.at(-1) !== end) return false;
  const up = git.parents(root, picks);
  const chained = picks.every(
    (s, i) => up.get(s)?.length === 1 && (i === 0 || up.get(s)[0] === picks[i - 1]),
  );
  const ids = git.identities(root, [...picks, ...landed]);
  return chained && picks.every((s, i) => ids.has(s) && ids.get(s) === ids.get(landed[i]));
}

// A finished ledger's `lane merge` record, proven against main now: `{ shas }` while its landed commits
// are main's first-parent commits right after its `preHead`, in order, the record is about the ledger's
// branch (`ofBranch`), and their change is still in effect on main's tip (`undone`); else `{ unsure }`.
function recorded(root, ledger, onto) {
  const main = git.commitOf(root, onto);
  const shas = ledger.merge.landed.map((s) => full(root, s));
  const from = full(root, ledger.merge.preHead);
  const chain = main && from ? git.commits(root, `${from}..${main}`, { firstParent: true }) : [];
  if (!shas.every((sha, i) => sha && chain[i] === sha))
    return { unsure: "merged, but those commits are no longer main's history (reset?)" };
  if (!ofBranch(root, ledger, shas))
    return { unsure: "merged, but its merge record does not match its branch's commits" };
  const off = undone(root, shas, main);
  return off ? { unsure: `merged, but ${said(off)}` } : { shas };
}

// A ledger's hand merge, by its branch alone.
const byHand = (root, ledger, onto) =>
  ledger.branch
    ? landing(root, { branch: ledger.branch, onto, bases: [ledger.base, ledger.mainAtStart?.head] })
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
  const life = spec.lifecycle;
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

// One task whose work stands as `landed()` on main (`{ shas }` or `{ unsure }`, asked only when the board
// lacks something): the merged event `board fix` would apply (only the missing steps), or why it is only
// reported. Nothing when the board has it all.
function plan({ root, spec, model, item, landed }) {
  const { need, field, status, cell, handoff } = gaps({ root, spec, model, item });
  const asWritten = (r) => commitsIn(item.fields[r.field ?? field]);
  if (!need.length && status === undefined && (!handoff || handedOff(handoff, asWritten)))
    return {};
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
const accept = (id) => `/agentry:board --fix --accept ${id ?? "<id>"}`;
// Work merged by hand from a worktree no ledger knows: `--branch` adopts it (a ledger; merge then finds
// nothing left to land), and only then can the owner accept it.
const adopt = (id, branch) => `${merge(id)} --branch ${branch}, then ${accept(id)}`;

export function nudges({ root, runRoot = root, spec, model }) {
  const life = spec.lifecycle;
  const items = workItems(spec, model);
  const all = ledgers.list(runRoot);
  const byId = new Map(all.map((l) => [l.id, l]));
  const onto = git.defaultBranch(root);
  // The checkout the board is in, from its git root: a board kept in a subfolder sees the worktrees too.
  const top = git.topLevel(root) || root;
  const found = [];

  for (const tree of git.worktrees(root).filter((t) => isAgentTree(t, { top, runRoot }))) {
    const known = all.find(
      (l) => l.worktree === tree.path || (tree.branch && l.branch === tree.branch),
    );
    if (known) continue;
    const id = taskIdOf(tree, items);
    const base = { ...(id ? { id } : {}), path: tree.path, branch: tree.branch ?? undefined };
    if (tree.branch && landing(root, { branch: tree.branch, onto }))
      found.push({ kind: "merged-by-hand", ...base, command: adopt(id, tree.branch) });
    else found.push({ kind: "unlisted-worktree", ...base, command: exec(id) });
  }

  for (const l of all) {
    const row = { id: l.id, ...(l.branch ? { branch: l.branch } : {}) };
    const work = l.merge ? null : byHand(root, l, onto);
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

  // One nudge per task: the first one found for its id.
  const seen = new Set();
  return found.filter((n) => !n.id || (!seen.has(n.id) && seen.add(n.id)));
}

// The one board item for `id`, or why there is not one.
function itemFor(spec, model, id) {
  const here = workItems(spec, model).filter((i) => i.id === id);
  return here.length === 1
    ? { item: here[0] }
    : { left: `${id}: on main, but ${here.length ? "several" : "no"} board items by that id` };
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
  for (const ledger of ledgers.list(runRoot).filter(finished)) {
    const { item, left: none } = itemFor(spec, model, ledger.id);
    const landed = () => recorded(root, ledger, onto);
    const found = item ? plan({ root, spec, model, item, landed }) : { left: none };
    if (found.fixes) fixes.push(found.fixes);
    if (found.left) left.push(found.left);
  }
  return { fixes, left };
}

/** What `board fix --accept <id>` may write once the owner says task `id` was merged by hand: the same
 *  `{ fixes, left }` as `mechanical`, for that task alone. Its ledger's branch must be on main by git
 *  (`landing`: commits on main to name, still in effect on main's tip); otherwise nothing is written and
 *  the reason is in `left`. */
export function accepted({ root, runRoot = root, spec, model, id }) {
  if (!spec.lifecycle) return { fixes: [], left: [`${id}: the process file has no lifecycle`] };
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
