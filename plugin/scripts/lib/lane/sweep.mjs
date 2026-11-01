// sweep — what a finished session leaves behind, and the removal of the part that is safely Agentry's (plan
// R1b-7, #8, #9). `plan` only looks: it lists
//   cleanable  the worktrees of tasks whose ledger says `merged` or `closed`, each with the ignored files
//              (`.env`, build output) removal would delete
//   unknown    worktrees in the lane's own directory that no ledger knows (reported, never removed)
//   strays     processes started under `<root>/.agentry/run/`: their executable, their script (for an
//              interpreter) or their working directory is there. A process that only names such a path in
//              its arguments (`tail -f …/gate.log`) is not one, and neither is one that belongs to a lane
//              still building
//   warnings   disk under 10 GB free
// `apply` then stops the strays (their whole process group when the process leads one, confirming they are
// gone) and removes the cleanable worktrees (through `worktree.remove`, which keeps a dirty one and any
// branch with unlanded work; one holding ignored files is kept unless `discardIgnored`). Nothing else is ever
// touched. Node built-ins only.
import { spawnSync } from "node:child_process";
import { realpathSync, statfsSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { worktrees } from "../process/git.mjs";
import * as ledgers from "../process/ledger.mjs";
import { ignoredFiles, remove, worktreesDir } from "./worktree.mjs";

const GB = 1024 ** 3;
export const LOW_DISK = 10 * GB;
const SETTLE_MS = 2000;
// A ledger in one of these states has nothing running: its leftovers are strays.
const FINISHED = ["merged", "closed", "stopped"];
// The first word of a command line whose second word is the script it runs.
const INTERPRETERS = [
  "node",
  "sh",
  "bash",
  "zsh",
  "python",
  "python3",
  "ruby",
  "deno",
  "bun",
  "tsx",
];

/** Free bytes on the volume holding `dir`, or null when it can't be read. */
export function freeBytes(dir) {
  try {
    const fs = statfsSync(dir);
    return fs.bavail * fs.bsize;
  } catch {
    return null;
  }
}

// `{ pid, pgid, stat, command }` for every process on the machine except this one and its parent (the
// command that ran the sweep may itself sit under the run directory).
function processes() {
  const res = spawnSync("ps", ["-axo", "pid=,pgid=,stat=,command="], { encoding: "utf8" });
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), stat: m[3], command: m[4] }))
    .filter((p) => p.pid !== process.pid && p.pid !== process.ppid);
}

// pid -> working directory, for every process lsof can see. Empty when lsof is missing.
function cwds() {
  const res = spawnSync("lsof", ["-a", "-d", "cwd", "-Fpn"], { encoding: "utf8" });
  const map = new Map();
  let pid = null;
  for (const line of (res.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) map.set(pid, line.slice(1));
  }
  return map;
}

const within = (path, dir) => path === dir || path.startsWith(dir + sep);
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// The paths a process stands on: its working directory, its executable and, for an interpreter, its script.
function footprint(p, cwd) {
  const [exe, ...args] = p.command.split(/\s+/);
  const paths = [cwd, exe];
  if (INTERPRETERS.includes(basename(exe))) paths.push(args.find((a) => !a.startsWith("-")));
  return paths
    .filter(Boolean)
    .map((path) => (isAbsolute(path) ? path : cwd ? resolve(cwd, path) : null))
    .filter(Boolean)
    .flatMap((path) => [...new Set([path, real(path)])]);
}

// The lane directories of a ledger: its worktree and its run files.
const laneDirs = (root, l) =>
  [
    l.worktree,
    join(worktreesDir(root), l.id),
    join(root, ".agentry", "run", "process", "runs", l.id),
  ]
    .filter(Boolean)
    .flatMap((d) => [...new Set([d, real(d)])]);

// The processes started under the run directory that no live lane owns.
function findStrays(root, all) {
  const dir = join(root, ".agentry", "run");
  const run = [...new Set([dir, real(dir)])];
  const cwd = cwds();
  const strays = [];
  for (const p of processes()) {
    const feet = footprint(p, cwd.get(p.pid));
    if (!feet.some((f) => run.some((r) => within(f, r)))) continue;
    const owner = all.find((l) => laneDirs(root, l).some((d) => feet.some((f) => within(f, d))));
    if (owner && !FINISHED.includes(owner.state)) continue;
    strays.push({ pid: p.pid, pgid: p.pgid, command: p.command });
  }
  return strays;
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
    else if (ledger.state === "merged" || ledger.state === "closed") {
      let ignored = [];
      try {
        ignored = ignoredFiles(tree.path);
      } catch {
        ignored = []; // no work tree there: nothing to lose
      }
      cleanable.push({ id: ledger.id, path: tree.path, branch: tree.branch, ignored });
    }
  }
  const warnings =
    free !== null && free < LOW_DISK
      ? [`only ${(free / GB).toFixed(1)} GB free on the disk (below ${LOW_DISK / GB} GB)`]
      : [];
  return { cleanable, unknown, strays: findStrays(root, all), diskFree: free, warnings };
}

// Whether anything of the stray is still running: the group it leads, or just the process. A zombie is dead.
function running(stray, group) {
  return processes().some(
    (p) => !p.stat.startsWith("Z") && (group ? p.pgid === stray.pgid : p.pid === stray.pid),
  );
}

// SIGTERM, then SIGKILL after SETTLE_MS; true once nothing of the stray is left running.
function stop(stray) {
  const group = stray.pgid === stray.pid; // it leads its own group: take its children down too
  const send = (signal) => {
    try {
      process.kill(group ? -stray.pgid : stray.pid, signal);
    } catch {
      // already gone
    }
  };
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    send(signal);
    for (let waited = 0; waited < SETTLE_MS && running(stray, group); waited += 100)
      Atomics.wait(nap, 0, 0, 100);
    if (!running(stray, group)) return true;
  }
  return false;
}

/** Do what `found` (a `plan`) lists: `{ removed: [{ id, branchDeleted }], kept: [{ id, reason }], killed: [pid],
 *  gone: [pid], survived: [pid] }`. A worktree `worktree.remove` keeps, or one holding ignored files while
 *  `discardIgnored` is off, is `kept` with its reason; a process already gone is `gone`; one still running
 *  after SIGKILL is `survived`. */
export function apply(root, found, { discardIgnored = false } = {}) {
  const done = { removed: [], kept: [], killed: [], gone: [], survived: [] };
  for (const p of found.strays) {
    if (!running(p, false)) done.gone.push(p.pid);
    else if (stop(p)) done.killed.push(p.pid);
    else done.survived.push(p.pid);
  }
  for (const w of found.cleanable) {
    if (w.ignored?.length && !discardIgnored) {
      done.kept.push({ id: w.id, reason: ignoredReason(w) });
      continue;
    }
    const res = remove(root, { path: w.path, branch: w.branch });
    if (res.removed) done.removed.push({ id: w.id, branchDeleted: res.branchDeleted });
    else done.kept.push({ id: w.id, reason: res.reason });
  }
  return done;
}

/** Why a worktree with ignored files stays. */
export const ignoredReason = (w) =>
  `holds ${w.ignored.length} ignored file(s) removal would delete (${w.ignored.slice(0, 3).join(", ")}); --discard-ignored to remove it anyway`;
