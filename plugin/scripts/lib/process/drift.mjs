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
// and the commits on main that carry it must still be in effect the same way. The git proof is
// `landing.mjs`, what the board lacks of a merge is `board-gaps.mjs`; this file names the nudges and the
// fixes. It reads files and git and writes none (the temp files of dead writers in the ledger directory
// are swept as they are listed); git goes through git.mjs, asked once per run for all the ledgers.
import { realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { shellWord as w } from "../text/shell.mjs";
import { lacking, plan } from "./board-gaps.mjs";
import * as git from "./git.mjs";
import { kindOf } from "./ids.mjs";
import { isKept } from "./keep.mjs";
import { byHand, finished, landing, recorded, records, survey } from "./landing.mjs";
import * as ledgers from "./ledger.mjs";
import { shownPath } from "./shown-path.mjs";
import { own } from "./spec/shape.mjs";
import { lifecycleOf } from "./spec/workflow.mjs";
import { readSpikes, spikesFile } from "./spikes.mjs";
import { staleStatus } from "./stale-status.mjs";

const workName = (spec) => spec.lifecycle?.kind;
const workItems = (spec, model) => {
  const name = workName(spec);
  return name ? (own(model.kinds, name)?.items ?? []) : [];
};

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
  const names = `${tree.branch ?? ""} ${basename(tree.path)}`.split(/[^A-Za-z0-9._-]+/);
  return items.map((i) => i.id).find((id) => names.includes(id));
}

const exec = (id) => `/agentry:exec ${id ?? "<id>"}`;
const merge = (id) => `/agentry:merge ${id ?? "<id>"}`;
const accept = (id) => `/agentry:board fix --accept ${id ?? "<id>"}`;
// Work merged by hand from a worktree no ledger knows: `--branch` adopts it (a ledger; merge then finds
// nothing left to land), and only then can the owner accept it.
const adopt = (id, branch) => `${merge(id)} --branch ${w(branch)}, then ${accept(id)}`;
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
// Why land, adopt and spike all refuse the branch `b` a worktree is on (`tips`: the branch list), or null:
// it has no commits yet (no branch has its name in any case), its HEAD is a spelling no branch is named
// (`git checkout WORKTREE-AGENT-X`), or another branch has its name in another case.
function refusedBranch(b, tips) {
  if (!b) return null;
  const twin = [...tips.keys()].find((t) => t !== b && t.toLowerCase() === b.toLowerCase());
  const then = "to land, continue or file it";
  if (!tips.has(b))
    return twin
      ? `it is on ${b}, which no branch is named: check it out by its exact name ${then}`
      : `${b} has no commits yet: commit on it ${then}`;
  return twin ? `${b} has a case twin ${twin}: rename one first ${then}` : null;
}
// An unlisted worktree not on main: those, file it (`lane spike`), or remove it (field 87). One on a
// branch they all refuse (`refusedBranch`) only removes, and the row says how to make them take it.
function unlisted(tree, runRoot, id, tips) {
  const path = w(shownPath(runRoot, tree.path));
  const refused = refusedBranch(tree.branch, tips);
  if (refused) return `remove: git worktree remove ${path} (${refused})`;
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
  // A branch land would refuse is never surveyed, nor offered as merged by hand.
  const named = (t) => !refusedBranch(t.branch, tips);
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
