// sweep — what a finished session leaves behind, and the removal of the part that is safely Agentry's (plan
// R1b-7, #8, #9). `plan` only looks: it lists
//   cleanable  the worktrees of tasks whose ledger says `merged` or `closed`, each with the ignored files
//              (`.env`, build output) removal would delete
//   unknown    worktrees in the lane's own directory that no ledger knows (reported, never removed)
//   strays     processes started under `<root>/.agentry/run/`: their executable, their script (for an
//              interpreter) or their working directory is there. A process that only names such a path in
//              its arguments (`tail -f …/gate.log`) is not one, and neither is one that belongs to a lane
//              still building
//   leftAlone  what would be a stray but is an interactive shell (a controlling terminal, a login shell,
//              `-i`): the owner's own terminal can sit in a merged worktree, and it is never signalled
//   warnings   disk under 10 GB free; `lsof` missing (a process is then judged by its executable and script
//              only, so one that merely stands in the run directory is not seen)
// `apply` then stops the strays (each with its whole descendant tree, confirming all of it is gone) and
// removes the cleanable worktrees (through `worktree.remove`, which keeps a dirty one and any branch with
// unlanded work; one holding ignored files is kept unless `discardIgnored`). Nothing else is ever touched.
// Node built-ins only.
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
// Shells that are interactive when run with `-i`.
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "fish"];
// The first word of a command line whose script is its first argument that is not an option.
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
// Interpreter options that take a value: the value is not the script.
const VALUE_OPTIONS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--input-type",
  "-m",
  "-W",
  "-X",
]);

/** Free bytes on the volume holding `dir`, or null when it can't be read. */
export function freeBytes(dir) {
  try {
    const fs = statfsSync(dir);
    return fs.bavail * fs.bsize;
  } catch {
    return null;
  }
}

// `{ pid, ppid, tty, stat, command }` for every process on the machine except this one and its parent (the
// command that ran the sweep may itself sit under the run directory). `tty`: it has a controlling terminal.
function processes() {
  const res = spawnSync("ps", ["-axo", "pid=,ppid=,tty=,stat=,command="], { encoding: "utf8" });
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      tty: !["??", "?", "-"].includes(m[3]),
      stat: m[4],
      command: m[5],
    }))
    .filter((p) => p.pid !== process.pid && p.pid !== process.ppid);
}

// Whether `p` is the owner's terminal: on a controlling terminal, a login shell (`-zsh`) or a shell run `-i`.
function interactive(p) {
  const [exe, ...args] = p.command.split(/\s+/);
  if (p.tty || exe.startsWith("-")) return true;
  return SHELLS.includes(basename(exe)) && args.some((a) => /^-[a-zA-Z]*i[a-zA-Z]*$/.test(a));
}

// The pids of `top` and everything below it, by parent pid, among `procs`.
function treeOf(top, procs) {
  const seen = new Set([top]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs)
      if (seen.has(p.ppid) && !seen.has(p.pid)) {
        seen.add(p.pid);
        grew = true;
      }
  }
  return seen;
}

// pid -> working directory for every process lsof can see, and whether lsof is missing altogether.
function cwds() {
  const res = spawnSync("lsof", ["-a", "-d", "cwd", "-Fpn"], { encoding: "utf8" });
  const map = new Map();
  let pid = null;
  for (const line of (res.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) map.set(pid, line.slice(1));
  }
  return { map, missing: res.error?.code === "ENOENT" };
}

const within = (path, dir) => path === dir || path.startsWith(dir + sep);
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// The first argument that is neither an option nor an option's value (`--require hook.cjs script.mjs`).
function scriptOf(args) {
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("-")) return args[i];
    if (VALUE_OPTIONS.has(args[i])) i++;
  }
  return undefined;
}

// The paths a process stands on: its working directory, its executable and, for an interpreter, its script.
function footprint(p, cwd) {
  const [exe, ...args] = p.command.split(/\s+/);
  const paths = [cwd, exe];
  if (INTERPRETERS.includes(basename(exe))) paths.push(scriptOf(args));
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

// The processes started under the run directory that no live lane owns: `{ strays, leftAlone, lsofMissing }`.
// A lane still building claims a process even where a finished ledger does too (a merged ledger whose
// worktree is the repo root contains everything).
function findStrays(root, all) {
  const dir = join(root, ".agentry", "run");
  const run = [...new Set([dir, real(dir)])];
  const cwd = cwds();
  const found = { strays: [], leftAlone: [], lsofMissing: cwd.missing };
  for (const p of processes()) {
    const feet = footprint(p, cwd.map.get(p.pid));
    if (!feet.some((f) => run.some((r) => within(f, r)))) continue;
    const owners = all.filter((l) => laneDirs(root, l).some((d) => feet.some((f) => within(f, d))));
    if (owners.some((l) => !FINISHED.includes(l.state))) continue;
    if (interactive(p))
      found.leftAlone.push({ pid: p.pid, command: p.command, reason: "interactive shell" });
    else found.strays.push({ pid: p.pid, command: p.command });
  }
  return found;
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
  const { strays, leftAlone, lsofMissing } = findStrays(root, all);
  const warnings = [];
  if (free !== null && free < LOW_DISK)
    warnings.push(`only ${(free / GB).toFixed(1)} GB free on the disk (below ${LOW_DISK / GB} GB)`);
  if (lsofMissing)
    warnings.push("lsof not found: a process that only stands in the run directory can't be seen");
  return { cleanable, unknown, strays, leftAlone, diskFree: free, warnings };
}

// The pids among `pids` still running (a zombie is dead).
const stillRunning = (pids) =>
  processes()
    .filter((p) => pids.has(p.pid) && !p.stat.startsWith("Z"))
    .map((p) => p.pid);

// SIGTERM, then SIGKILL after SETTLE_MS, to the stray and everything below it, never to a terminal or an
// interactive shell among them (nor what hangs under one). The set grows with children that appear and keeps
// the pids of ones whose parent died first (they are re-parented, so only the set still names them).
// Returns the pids still running afterwards.
function stop(stray) {
  const members = new Set([stray.pid]);
  const grow = () => {
    const procs = processes();
    for (const top of [...members]) for (const pid of treeOf(top, procs)) members.add(pid);
    for (const p of procs)
      if (interactive(p) && p.pid !== stray.pid)
        for (const pid of treeOf(p.pid, procs)) members.delete(pid);
  };
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    grow();
    for (const pid of stillRunning(members)) {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
    for (let waited = 0; waited < SETTLE_MS; waited += 100) {
      if (!stillRunning(members).length) return [];
      Atomics.wait(nap, 0, 0, 100);
    }
  }
  return stillRunning(members);
}

/** Do what `found` (a `plan`) lists: `{ removed: [{ id, branchDeleted }], kept: [{ id, reason }], killed: [pid],
 *  gone: [pid], survived: [pid], survivors: [pid] }`. A worktree `worktree.remove` keeps, or one holding
 *  ignored files while `discardIgnored` is off, is `kept` with its reason; a process already gone is `gone`;
 *  a stray with anything of its tree still running after SIGKILL is `survived` (its pid), and the pids still
 *  running are `survivors`. */
export function apply(root, found, { discardIgnored = false } = {}) {
  const done = { removed: [], kept: [], killed: [], gone: [], survived: [], survivors: [] };
  for (const p of found.strays) {
    if (!stillRunning(new Set([p.pid])).length) {
      done.gone.push(p.pid);
      continue;
    }
    const left = stop(p);
    if (left.length) {
      done.survived.push(p.pid);
      done.survivors.push(...left);
    } else done.killed.push(p.pid);
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
