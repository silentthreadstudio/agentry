// exec/guard/snapshot — the git facts the main guard reads: main's changed paths and the content id of
// each, the snapshot `start` records, and the main commit a lane's branch holds past its base (a
// commit's content ids are `carry-io.mjs`'s `blobsAt`).
import { contentOf as contentIds } from "../../../process/board-writes.mjs";
import { resolveBranch } from "../../adopt.mjs";
import { isAncestor, mergeBaseOf } from "../../land.mjs";
import { dirtyEntries } from "../../own-memory.mjs";
import { git } from "../../worktree.mjs";
import { refuse } from "../lane.mjs";

// Agentry's own files: the run state. (The memory records a lane writes are `own-memory.mjs`'s.)
const OWN_DIRS = [".agentry/run/"];
export const STAGED = /^[MADRC]/;
export const stagedKey = (entry) => `${entry[0]}${entry.slice(3)}`; // index column + path
export const headOf = (dir, ref = "HEAD") =>
  git(dir, ["rev-parse", "--verify", "--quiet", ref]).stdout.trim();

// Main's changed paths (Agentry's run files and new memory records left out) → their `git status` entry; a rename
// comes as its delete and its add (`porcelain`), so both paths are checked.
export function dirtyPaths(root) {
  const parts = dirtyEntries(root);
  if (!parts) refuse(`git status failed in ${root}`);
  const out = new Map();
  for (const entry of parts) {
    const path = entry.slice(3);
    if (!OWN_DIRS.some((d) => path.startsWith(d)) && !STAGED.test(out.get(path) ?? ""))
      out.set(path, entry); // a staged entry stays when the path is also untracked (`rm --cached`)
  }
  return out;
}

// What is stored for each path as it is in main's working tree (`board-writes.mjs`): the ids recorded
// lifecycle and board writes carry.
export function contentOf(root, paths) {
  try {
    return contentIds(root, paths);
  } catch (e) {
    return refuse(e.message);
  }
}

/** What main looks like when a lane starts: HEAD, the `git status` entries and the content of each. */
export function mainSnapshot(root) {
  const dirty = dirtyPaths(root);
  return {
    head: headOf(root),
    porcelain: [...new Set(dirty.values())],
    files: contentOf(root, [...dirty.keys()]),
    modes: true, // `files` ids carry `:x` / `:l`; a ledger without this holds an executable as a bare id
  };
}

// The main commit the lane's branch holds past `since`, or null: the merge base of main's HEAD and the
// branch's listed tip, when it is a descendant of `since` (an in-branch rebase or merge of main).
export function heldMain(root, ledger, since) {
  const tip = resolveBranch(root, ledger.branch).tip;
  const base = since && tip ? mergeBaseOf(root, "HEAD", tip) : null;
  return base && base !== since && isAncestor(root, since, base) ? base : null;
}

// Where the lane's own commits start: the merge base with main once the branch holds main past
// its base (the guard's start moved to it, `startMoves`), else the base. `<start>..<tip>` is never main's
// commits the branch holds.
export const ownStart = (root, ledger) => heldMain(root, ledger, ledger.base) ?? ledger.base;
