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
// `verified-not-merged` (verified, waiting for merge) and `episode-pending` (an episode payload nobody wrote).
// Without a `lifecycle` the board has no started words, so `started-by-hand` stays quiet.
//
// Work counts as landed only while it is on main now (A23): its commits there (cherry-picked, merged or
// fast-forwarded) and no later commit undoing one of them. Read-only.
import { realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { git as runGit } from "../lane/worktree.mjs";
import * as git from "./git.mjs";
import * as ledgers from "./ledger.mjs";
import { leadTokens, parentOf } from "./rules/structure.mjs";
import { own } from "./spec.mjs";

const MERGED_STATES = ["merged", "closed"];
const SHA_TOKEN = /[0-9a-f]{7,40}/gi;

const workName = (spec) => spec.lifecycle?.kind;
const workItems = (spec, model) => {
  const name = workName(spec);
  return name ? (own(model.kinds, name)?.items ?? []) : [];
};

// ---- git, read-only: every helper answers null / false / [] on any failure ----

const safeRef = (ref) => typeof ref === "string" && ref.length > 0 && !ref.startsWith("-");
const out = (root, args, input) => {
  const res = runGit(root, args, input);
  return res.status === 0 ? res.stdout : null;
};
const commitOf = (root, ref) =>
  (safeRef(ref) && out(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim()) ||
  null;
const isAncestor = (root, a, b) => runGit(root, ["merge-base", "--is-ancestor", a, b]).status === 0;
const words = (text) => (text ?? "").split(/\s+/).filter(Boolean);

// Stable patch ids of the non-merge commits `git log` lists for `args`, in its order: `{ pid, sha }`.
function pids(root, args) {
  const patches = out(root, [
    "log",
    "-p",
    "--no-color",
    "--no-ext-diff",
    "--no-merges",
    ...args,
    "--",
  ]);
  const ids = patches ? out(root, ["patch-id", "--stable"], patches) : null;
  return (ids ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, sha] = line.split(" ");
      return { pid, sha };
    });
}

// A reflog entry that made the commit on the branch itself (not a reset, a fast-forward or a merge).
const MADE = /^(commit( \((amend|initial)\))?|cherry-pick|revert): /;

// The commits made on `branch` itself, oldest first, once its tip is on main (merge-base is then the tip):
// `<base>..<tip>` for the first of `bases` (the ledger's) that is a proper ancestor, else the commits its
// reflog says were made on it. When the reflog does not show the tip made there (a branch reset or
// fast-forwarded to main, or never committed to), it has no work of its own: null. undefined when nothing
// tells.
function ownCommits(root, { tip, branch, bases }) {
  const log = safeRef(branch)
    ? out(root, ["log", "-g", "--format=%H %gs", `refs/heads/${branch}`, "--"])
    : null;
  const entries = (log ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(" ");
      return { sha: line.slice(0, at), made: MADE.test(line.slice(at + 1)) };
    });
  if (entries.length && !(entries[0].sha === tip && entries[0].made)) return null;
  const base = bases
    .map((ref) => commitOf(root, ref))
    .find((c) => c && c !== tip && isAncestor(root, c, tip));
  if (base)
    return words(
      out(root, ["rev-list", "--first-parent", "--no-merges", "--reverse", `${base}..${tip}`]),
    );
  if (!entries.length) return undefined;
  const made = [...new Set(entries.filter((e) => e.made).map((e) => e.sha))].reverse();
  return made.filter((sha) => isAncestor(root, sha, tip));
}

/** True when each of `shas` is on `main` and still in effect: the newest commit after it that carries its
 *  patch or the inverse patch is not the inverse (a revert; a revert of that revert counts as the patch). */
export function inEffect(root, shas, main) {
  const full = shas.map((s) => commitOf(root, s));
  if (!full.length || !full.every((s) => s && isAncestor(root, s, main))) return false;
  const walk = ["--no-walk=unsorted", ...full];
  const patch = new Map(pids(root, walk).map((p) => [p.sha, p.pid]));
  const undo = new Map(
    pids(root, ["-R", "--src-prefix=b/", "--dst-prefix=a/", ...walk]).map((p) => [p.sha, p.pid]),
  );
  return full.every((sha) => {
    if (!undo.has(sha)) return true; // an empty commit: nothing to undo
    const last = pids(root, ["--topo-order", `${sha}..${main}`]).find(
      (p) => p.pid === undo.get(sha) || p.pid === patch.get(sha),
    );
    return last?.pid !== undo.get(sha);
  });
}

// Every file the branch changed since `fork` is the same on main as on the branch.
function sameContent(root, { fork, tip, main }) {
  const files = (out(root, ["diff", "--no-renames", "--name-only", "-z", fork, tip]) ?? "")
    .split("\0")
    .filter(Boolean);
  if (!files.length) return false;
  // The names are from the top of the repository, wherever `root` sits in it.
  const paths = files.map((f) => `:(top,literal)${f}`);
  return runGit(root, ["diff", "--quiet", main, tip, "--", ...paths]).status === 0;
}

/** Where `branch`'s work stands on `onto` now: `{ shas }`, the commits on main that carry it (oldest first),
 *  `{ unsure }` when its changes are on main but no commits can be named for them (a squash; a tip on main
 *  with no reflog or base to tell its own commits), or null when it is not on main (never landed, partly
 *  landed, or undone). `bases` are refs the branch may have been cut from (the ledger's `base`). */
export function landing(root, { branch, onto, bases = [] }) {
  const tip = commitOf(root, branch);
  const main = commitOf(root, onto);
  if (!tip || !main || branch === onto) return null;
  let fork;
  let shas = null;
  if (isAncestor(root, tip, main)) {
    // Merged (--no-ff) or fast-forwarded: the branch's own commits are main's.
    shas = ownCommits(root, { tip, branch, bases });
    if (shas === undefined)
      return { unsure: "its tip is on main, but not which commits are its own" };
    if (!shas?.length) return null;
    fork = commitOf(root, `${shas[0]}^`);
  } else {
    // Cherry-picked: every commit of the branch has a commit on main with its patch id.
    fork = out(root, ["merge-base", main, tip])?.trim();
    if (!fork) return null;
    const mine = pids(root, [`${main}..${tip}`]);
    if (!mine.length) return null;
    const theirs = new Map();
    for (const p of pids(root, [`${tip}..${main}`]))
      if (!theirs.has(p.pid)) theirs.set(p.pid, p.sha);
    const found = mine.map((p) => theirs.get(p.pid)).reverse();
    shas = found.every(Boolean) ? found : null;
  }
  if (shas && inEffect(root, shas, main)) return { shas };
  return fork && sameContent(root, { fork, tip, main })
    ? { unsure: "on main, but no commit there matches its own (squashed?)" }
    : null;
}

// The ledger's work on main: its merge record's commits while still in effect, else its branch's landing.
// null while a merge is under way or nothing landed.
function landedWork(root, ledger, onto) {
  const rec = ledger.merge;
  if (!rec)
    return ledger.branch
      ? landing(root, {
          branch: ledger.branch,
          onto,
          bases: [ledger.base, ledger.mainAtStart?.head],
        })
      : null;
  if (!MERGED_STATES.includes(ledger.state) || !Array.isArray(rec.landed) || !rec.landed.length)
    return null;
  const main = commitOf(root, onto);
  if (main && inEffect(root, rec.landed, main))
    return { shas: rec.landed.map((s) => commitOf(root, s)) };
  return { unsure: "merged, but those commits are undone on main (reverted?)" };
}

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
  const words = `${tree.branch ?? ""} ${basename(tree.path)}`.split(/[^A-Za-z0-9._-]+|\//);
  return items.map((i) => i.id).find((id) => words.includes(id));
}

const exec = (id) => `/agentry:exec ${id ?? "<id>"}`;
const merge = (id) => `/agentry:merge ${id ?? "<id>"}`;
const FIX = "/agentry:board --fix";

export function nudges({ root, runRoot = root, spec, model }) {
  const life = spec.lifecycle;
  const items = workItems(spec, model);
  const all = ledgers.list(runRoot);
  const byId = new Map(all.map((l) => [l.id, l]));
  const onto = git.defaultBranch(root);
  const found = [];

  // The checkout the board is in, from its git root: a board kept in a subfolder sees the worktrees too.
  const top = out(root, ["rev-parse", "--show-toplevel"])?.trim() || root;
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
    if (l.state === "verified" && !l.merge)
      found.push({ kind: "verified-not-merged", ...row, command: merge(l.id) });
    if (l.episode && !l.episode.writtenId)
      found.push({ kind: "episode-pending", ...row, command: "/agentry:close" });
    // A ledgered branch already on main: only a nudge while the board has not caught up.
    if (!l.merge && landedWork(root, l, onto)) {
      const item = items.find((i) => i.id === l.id);
      const { fixes, left } = item
        ? plan({ root, runRoot, spec, model, ledger: l, item, onto })
        : {};
      if (!item || fixes || left) found.push({ kind: "merged-by-hand", ...row, command: FIX });
    }
  }

  const started = [life?.on?.dispatched, life?.on?.built].filter((w) => typeof w === "string");
  for (const item of items)
    if (started.includes(item.status) && !byId.has(item.id))
      found.push({ kind: "started-by-hand", id: item.id, command: exec(item.id) });
  return found;
}

// What the lifecycle's merged event would still write for `item`, given the commits `shas` that landed:
// the status, the commit cell, the handoff line. `conflict` when the commit cell holds other commits.
function missing({ spec, model, item, shas }) {
  const life = spec.lifecycle;
  const need = [];
  if (typeof life.on?.merged === "string" && item.status !== life.on.merged) need.push("status");
  const field = own(life.write, "commit");
  let conflict = null;
  if (typeof field === "string") {
    const cell = [item.fields[field] ?? []].flat().join(" ");
    const named = cell.match(SHA_TOKEN) ?? [];
    if (!named.length) need.push("commit");
    else if (!named.every((t) => shas.some((s) => s.startsWith(t.toLowerCase()))))
      conflict = `${item.id}: its ${field} cell names other commits than the ledger's; left alone`;
  }
  const target = own(life.write, "handoff");
  if (typeof target === "string") {
    const section = target.slice("parent.file:".length);
    const parent = parentOf(model, item);
    const leads = parent?.own ? (own(parent.own.sections, section)?.leads ?? []) : null;
    if (leads && !leads.some((l) => leadTokens(l.lead).includes(item.id))) need.push("handoff");
  }
  return { need, conflict };
}

// One ledgered task: the merged event `board fix` would apply, or why it is only reported.
function plan({ root, spec, model, ledger, item, onto }) {
  const landed = landedWork(root, ledger, onto);
  if (!landed) return {};
  const shas = landed.shas ?? [];
  const { need, conflict } = missing({ spec, model, item, shas });
  if (!need.length && !conflict) return {};
  if (landed.unsure) return { left: `${item.id}: ${landed.unsure}` };
  if (conflict) return { left: conflict };
  if (!need.length) return {};
  return { fixes: { id: item.id, shas, need } };
}

/** What `board fix` may write (`fixes`: `{ id, shas, need }`, each one merged event) and what it
 *  only reports (`left`: lines). A task is fixed only when a ledger's work is on main now (its merge
 *  record's commits, or its branch's commits picked, merged or fast-forwarded there) and the board lacks
 *  the status, commit or handoff line. */
export function mechanical({ root, runRoot = root, spec, model }) {
  const fixes = [];
  const left = [];
  if (!spec.lifecycle) return { fixes, left };
  const items = workItems(spec, model);
  const onto = git.defaultBranch(root);
  for (const ledger of ledgers.list(runRoot)) {
    const here = items.filter((i) => i.id === ledger.id);
    const mergedAlready = ledger.merge && MERGED_STATES.includes(ledger.state);
    if (here.length !== 1) {
      if (mergedAlready)
        left.push(
          `${ledger.id}: merged, but ${here.length ? "several" : "no"} board items by that id`,
        );
      continue;
    }
    const found = plan({ root, spec, model, ledger, item: here[0], onto });
    if (found.fixes) fixes.push(found.fixes);
    if (found.left) left.push(found.left);
  }
  return { fixes, left };
}
