// drift — work done outside Agentry's commands, found by comparing the worktrees, the ledgers, the board and
// main with each other (A35; plan R1b-6). No hook: `board status` asks every time. Two answers:
//
//   nudges(args)     -> [{ kind, id?, path?, branch?, command }]   what to flag, naming the command to use
//   mechanical(args) -> { fixes, left }                            what `board fix` may write, and what it only reports
// with args { root, runRoot, spec, model }: `root` is the checkout the board is read from (it may sit in a
// subfolder), `runRoot` the main checkout, where the ledgers live.
//
// A nudge kind: `unlisted-worktree` (an agent worktree no ledger knows), `started-by-hand` (a task the board
// has started and no ledger tracks), `merged-by-hand` (commits on main that no merge record covers),
// `verified-not-merged` (verified, waiting for merge) and `episode-pending` (an episode payload nobody wrote).
// Without a `lifecycle` the board has no started words, so `started-by-hand` stays quiet. Read-only.
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

/** Commits on `onto` that carry the same changes as the commits of `branch` (patch ids), oldest first. Empty
 *  unless every commit of the branch is there, and the branch has at least one. */
export function landedShas(root, branch, onto) {
  if (!branch || !onto) return [];
  const mine = git.patchIds(root, `${onto}..${branch}`);
  if (!mine.length) return [];
  const theirs = new Map(git.patchIds(root, `${branch}..${onto}`).map((p) => [p.patchId, p.sha]));
  const shas = mine.map((p) => theirs.get(p.patchId));
  return shas.every(Boolean) ? shas.reverse() : [];
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
  const out = [];

  // The checkout the board is in, from its git root: a board kept in a subfolder sees the worktrees too.
  const top = runGit(root, ["rev-parse", "--show-toplevel"]).stdout.trim() || root;
  for (const tree of git.worktrees(root).filter((t) => isAgentTree(t, { top, runRoot }))) {
    const known = all.find(
      (l) => l.worktree === tree.path || (tree.branch && l.branch === tree.branch),
    );
    if (known) continue;
    const id = taskIdOf(tree, items);
    const base = { ...(id ? { id } : {}), path: tree.path, branch: tree.branch ?? undefined };
    if (tree.branch && landedShas(root, tree.branch, onto).length)
      out.push({ kind: "merged-by-hand", ...base, command: merge(id) });
    else out.push({ kind: "unlisted-worktree", ...base, command: exec(id) });
  }

  for (const l of all) {
    const row = { id: l.id, ...(l.branch ? { branch: l.branch } : {}) };
    if (l.state === "verified" && !l.merge)
      out.push({ kind: "verified-not-merged", ...row, command: merge(l.id) });
    if (l.episode && !l.episode.writtenId)
      out.push({ kind: "episode-pending", ...row, command: "/agentry:close" });
    // A ledgered branch already on main: only a nudge while the board has not caught up.
    if (!l.merge && l.branch && landedShas(root, l.branch, onto).length) {
      const item = items.find((i) => i.id === l.id);
      const { fixes, left } = item
        ? plan({ root, runRoot, spec, model, ledger: l, item, onto })
        : {};
      if (!item || fixes || left) out.push({ kind: "merged-by-hand", ...row, command: FIX });
    }
  }

  const started = [life?.on?.dispatched, life?.on?.built].filter((w) => typeof w === "string");
  for (const item of items)
    if (started.includes(item.status) && !byId.has(item.id))
      out.push({ kind: "started-by-hand", id: item.id, command: exec(item.id) });
  return out;
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
  const rec = ledger.merge;
  const shas = !rec
    ? landedShas(root, ledger.branch, onto)
    : MERGED_STATES.includes(ledger.state) && Array.isArray(rec.landed)
      ? rec.landed
      : [];
  if (!shas.length) return {};
  const { need, conflict } = missing({ spec, model, item, shas });
  if (conflict) return { left: conflict };
  if (!need.length) return {};
  return { fixes: { id: item.id, shas, need } };
}

/** What `board fix` may write (`fixes`: `{ id, shas, need }`, each one merged event) and what it
 *  only reports (`left`: lines). A task is fixed only when a ledger says its commits landed (a merge record,
 *  or its branch's patch ids all on main) and the board lacks the status, commit or handoff line. */
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
