// sweep — what a finished session leaves behind, and the removal of the part that is safely Agentry's (plan
// R1b-7, #8, #9). `plan` only looks: it lists
//   cleanable  the worktrees of tasks whose ledger says `merged`
//   unknown    worktrees in the lane's own directory that no ledger knows (reported, never removed)
//   strays     processes whose command line is under `<root>/.agentry/run/` (a gate or builder left running)
//   warnings   disk under 10 GB free
// `apply` then removes the cleanable worktrees (through `worktree.remove`, which keeps a dirty one and any
// branch with unlanded work) and sends SIGTERM to the strays. Nothing else is ever touched. Node built-ins only.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statfsSync } from "node:fs";
import { join, sep } from "node:path";
import { worktrees } from "../process/git.mjs";
import * as ledgers from "../process/ledger.mjs";
import { remove, worktreesDir } from "./worktree.mjs";

const GB = 1024 ** 3;
export const LOW_DISK = 10 * GB;

/** Free bytes on the volume holding `dir`, or null when it can't be read. */
export function freeBytes(dir) {
  try {
    const fs = statfsSync(dir);
    return fs.bavail * fs.bsize;
  } catch {
    return null;
  }
}

// `{ pid, command }` for every process on the machine except this one and its parent (the command that ran
// the sweep may itself sit under the run directory).
function processes() {
  const res = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), command: m[2] }))
    .filter((p) => p.pid !== process.pid && p.pid !== process.ppid);
}

// The run directory as a command line may spell it: as given and with symlinks resolved.
function runPrefixes(root) {
  const dir = join(root, ".agentry", "run");
  return [...new Set([dir, existsSync(dir) ? realpathSync(dir) : dir])].map((d) => d + sep);
}

/** What a sweep would do in the repo whose main checkout is `root`. `free` overrides the disk reading. */
export function plan(root, { free = freeBytes(root) } = {}) {
  const all = ledgers.list(root);
  const cleanable = [];
  const unknown = [];
  for (const tree of worktrees(root)) {
    if (!tree.path.startsWith(worktreesDir(root) + sep)) continue;
    const ledger = all.find(
      (l) => l.worktree === tree.path || (tree.branch && l.branch === tree.branch),
    );
    if (!ledger) unknown.push({ path: tree.path, branch: tree.branch });
    else if (ledger.state === "merged")
      cleanable.push({ id: ledger.id, path: tree.path, branch: tree.branch });
  }
  const prefixes = runPrefixes(root);
  const strays = processes().filter((p) => prefixes.some((prefix) => p.command.includes(prefix)));
  const warnings =
    free !== null && free < LOW_DISK
      ? [`only ${(free / GB).toFixed(1)} GB free on the disk (below ${LOW_DISK / GB} GB)`]
      : [];
  return { cleanable, unknown, strays, diskFree: free, warnings };
}

/** Do what `found` (a `plan`) lists: `{ removed: [{ id, branchDeleted }], kept: [{ id, reason }], killed: [pid],
 *  gone: [pid] }`. A worktree `worktree.remove` keeps is `kept` with its reason; a process already gone is `gone`. */
export function apply(root, found) {
  const done = { removed: [], kept: [], killed: [], gone: [] };
  for (const w of found.cleanable) {
    const res = remove(root, { path: w.path, branch: w.branch });
    if (res.removed) done.removed.push({ id: w.id, branchDeleted: res.branchDeleted });
    else done.kept.push({ id: w.id, reason: res.reason });
  }
  for (const p of found.strays) {
    try {
      process.kill(p.pid, "SIGTERM");
      done.killed.push(p.pid);
    } catch {
      done.gone.push(p.pid);
    }
  }
  return done;
}
