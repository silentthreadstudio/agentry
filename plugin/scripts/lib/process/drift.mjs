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
// Done is written only when provable (A23): a `lane merge` record whose landed commits are still main's
// first-parent history and whose net change still reverse-applies on main's tip. Anything else is "unsure"
// and nothing is written. A hand merge (no record) is a nudge to `board fix --accept <id>`: the owner says it
// landed, and the branch's net change must still reverse-apply on main. Read-only; git goes through git.mjs.
import { realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import * as git from "./git.mjs";
import * as ledgers from "./ledger.mjs";
import * as md from "./markdown.mjs";
import { readInside } from "./read.mjs";
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

// A reflog entry that made the commit on the branch itself (not a reset, a fast-forward or a merge).
const MADE = /^(commit( \((amend|initial)\))?|cherry-pick|revert): /;

// The commits made on `branch` itself, oldest first, once its tip is on main (merge-base is then the tip):
// `<base>..<tip>` for the first of `bases` (the ledger's) that is a proper ancestor, else the commits its
// reflog says were made on it. When the reflog does not show the tip made there (a branch reset or
// fast-forwarded to main, or never committed to), it has no work of its own: null. undefined when nothing
// tells.
function ownCommits(root, { tip, branch, bases }) {
  const entries = git.reflog(root, branch).map((e) => ({ sha: e.sha, made: MADE.test(e.says) }));
  if (entries.length && !(entries[0].sha === tip && entries[0].made)) return null;
  const base = bases
    .map((ref) => git.commitOf(root, ref))
    .find((c) => c && c !== tip && git.isAncestor(root, c, tip));
  if (base) return git.commits(root, `${base}..${tip}`, { firstParent: true, noMerges: true });
  if (!entries.length) return undefined;
  const made = [...new Set(entries.filter((e) => e.made).map((e) => e.sha))].reverse();
  return made.filter((sha) => git.isAncestor(root, sha, tip));
}

/** Where `branch`'s work stands on `onto` now, from git alone (no merge record): `{ shas }`, the commits on
 *  main that carry it (oldest first); `{ unsure }` when its change is on main but no commits there can be
 *  named for it (a squash; a tip on main with no reflog or base to tell its own commits); null when it is
 *  not on main. On main means the branch's net change reverse-applies on main's tip, so a revert, a reset
 *  or a hand edit that took any of its lines out leaves it off. `bases` are refs the branch may have been
 *  cut from (the ledger's `base`). */
export function landing(root, { branch, onto, bases = [] }) {
  const tip = git.commitOf(root, branch);
  const main = git.commitOf(root, onto);
  if (!tip || !main || branch === onto) return null;
  let fork;
  let shas = null;
  if (git.isAncestor(root, tip, main)) {
    // Merged (--no-ff) or fast-forwarded: the branch's own commits are main's.
    shas = ownCommits(root, { tip, branch, bases });
    if (shas === undefined)
      return { unsure: "its tip is on main, but not which commits are its own" };
    if (!shas?.length) return null;
    fork = git.commitOf(root, `${shas[0]}^`);
  } else {
    // Cherry-picked: every commit of the branch has a commit on main with its patch id.
    fork = git.mergeBase(root, main, tip);
    const mine = fork ? git.patchIds(root, `${main}..${tip}`) : [];
    if (!mine.length) return null;
    const theirs = new Map();
    for (const p of git.patchIds(root, `${tip}..${main}`))
      if (!theirs.has(p.patchId)) theirs.set(p.patchId, p.sha);
    const found = mine.map((p) => theirs.get(p.patchId)).reverse();
    shas = found.every(Boolean) ? found : null;
  }
  if (!fork || !git.reverseApplies(root, { from: fork, to: tip, onto: main })) return null;
  return shas ? { shas } : { unsure: "on main, but no commit there matches its own (squashed?)" };
}

// A merged ledger's `lane merge` record, proven against main now: `{ shas }` while the landed commits are
// main's first-parent commits right after the first one's parent, in order, and their net change (the
// branch's, picked) still reverse-applies on main's tip; else `{ unsure }`. null while no merge has finished.
function recorded(root, ledger, onto) {
  const landed = ledger.merge?.landed;
  if (!MERGED_STATES.includes(ledger.state) || !Array.isArray(landed) || !landed.length)
    return null;
  const main = git.commitOf(root, onto);
  const shas = landed.map((s) => (typeof s === "string" ? git.commitOf(root, s) : null));
  const from = shas[0] && git.commitOf(root, `${shas[0]}^`);
  const chain = main && from ? git.commits(root, `${from}..${main}`, { firstParent: true }) : [];
  const onMain = shas.every((sha, i) => sha && chain[i] === sha);
  if (onMain && git.reverseApplies(root, { from, to: shas.at(-1), onto: main })) return { shas };
  return { unsure: "merged, but those commits are undone on main (reverted or reset?)" };
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

// Does `line` name `id` as a whole token? A sentence's closing `.` (or a trailing `-`, `_`) is not part of it.
const namesId = (line, id) =>
  line.split(/[^A-Za-z0-9._-]+/).some((t) => t === id || t.replace(/[._-]+$/, "") === id);

// Does the parent's handoff section hold any line naming `item` (bold lead or not, written by hand or by
// the lifecycle)? Any such line is the handoff. null when there is no such section to write to (the
// lifecycle refuses then).
function hasHandoff(root, spec, model, item, target) {
  const section = target.slice("parent.file:".length);
  const parent = parentOf(model, item);
  const heading = parent?.own && own(spec.kinds[parent.kind].file?.sections, section)?.heading;
  const text = heading ? readInside(root, join(root, spec.root, parent.own.path)) : null;
  const sec = text === null ? null : md.section(text, heading);
  if (!sec) return null;
  return text
    .split("\n")
    .slice(sec.line, sec.end)
    .some((line) => namesId(line, item.id));
}

// What the board lacks of the lifecycle's merged event for `item`: `need` (steps) and the hand-written state
// that stops a write: `status` (a status the lifecycle never sets before a merge) and `cell` (a commit cell
// that already holds text).
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
  if (typeof target === "string" && hasHandoff(root, spec, model, item, target) === false)
    need.push("handoff");
  return { need, field, ...found };
}

// One task whose work stands as `landed` on main (`{ shas }` or `{ unsure }`): the merged event `board fix`
// would apply (only the missing steps), or why it is only reported. Nothing when the board has it all.
function plan({ root, spec, model, item, landed }) {
  const { need, field, status, cell } = gaps({ root, spec, model, item });
  if (!need.length && status === undefined) return {};
  if (landed.unsure) return { left: `${item.id}: ${landed.unsure}` };
  const short = landed.shas[0].slice(0, 7);
  if (status !== undefined)
    return {
      left: `${item.id}: on main (${short}), but status "${status}" is set by hand; left alone`,
    };
  let shas = landed.shas;
  if (cell !== undefined) {
    // A hand-written cell is never rewritten; the handoff then names the cell's first commit.
    const named = (cell.match(SHA_TOKEN) ?? []).map((t) =>
      landed.shas.find((s) => s.startsWith(t.toLowerCase())),
    );
    if (!named.length || !named.every(Boolean))
      return {
        left: `${item.id}: ${field} cell "${cell}" is not the landed ${short}; left alone`,
      };
    shas = named;
  }
  return need.length ? { fixes: { id: item.id, shas, need } } : {};
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
const accept = (id) => `/agentry:board --fix --accept ${id}`;

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
      found.push({ kind: "merged-by-hand", ...base, command: merge(id) });
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
        ? plan({ root, spec, model, item, landed: work })
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
 *  handoff line. A merge with no record is never written here (see `accepted`). Hand-written state is never
 *  overwritten: a status the lifecycle does not set before a merge, or a commit cell that does not name the
 *  landed commits, is reported instead. */
export function mechanical({ root, runRoot = root, spec, model }) {
  const fixes = [];
  const left = [];
  if (!spec.lifecycle) return { fixes, left };
  const onto = git.defaultBranch(root);
  for (const ledger of ledgers.list(runRoot)) {
    const landed = recorded(root, ledger, onto);
    if (!landed) continue;
    const { item, left: none } = itemFor(spec, model, ledger.id);
    const found = item ? plan({ root, spec, model, item, landed }) : { left: none };
    if (found.fixes) fixes.push(found.fixes);
    if (found.left) left.push(found.left);
  }
  return { fixes, left };
}

/** What `board fix --accept <id>` may write once the owner says task `id` was merged by hand: the same
 *  `{ fixes, left }` as `mechanical`, for that task alone. Its ledger's branch must be on main by git
 *  (`landing`: commits on main to name, and its net change still reverse-applies on main's tip); otherwise
 *  nothing is written and the reason is in `left`. */
export function accepted({ root, runRoot = root, spec, model, id }) {
  if (!spec.lifecycle) return { fixes: [], left: [`${id}: the process file has no lifecycle`] };
  const ledger = ledgers.list(runRoot).find((l) => l.id === id);
  const work = ledger && byHand(root, ledger, git.defaultBranch(root));
  const { item, left: none } = itemFor(spec, model, id);
  let found;
  if (!ledger?.branch) found = { left: `${id}: no ledger names its branch; nothing to accept` };
  else if (!item) found = { left: none };
  else
    found = plan({
      root,
      spec,
      model,
      item,
      landed: work ?? { unsure: "its branch's change is not all on main; not accepted" },
    });
  return { fixes: found.fixes ? [found.fixes] : [], left: found.left ? [found.left] : [] };
}
