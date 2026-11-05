// sweep — what a finished session leaves behind, and the removal of the part that is safely Agentry's (plan
// R1b-7, #8, #9). `plan` only looks: it lists
//   cleanable  the worktrees of tasks whose ledger says `merged` or `closed`, each with the ignored files
//              (`.env`, screenshots) removal would delete, and the disposable ones (`DEFAULT_DISPOSABLE` and
//              the process file's `cleanup.disposable`, as `merge --cleanup` matches them) it discards
//              without asking
//   unknown    worktrees in the lane's own directory that no ledger knows (reported, never removed)
//   strays     processes started under `<root>/.agentry/run/`: their executable, their script (for an
//              interpreter) or their working directory is there. A process that only names such a path in
//              its arguments (`tail -f …/gate.log`) is not one, and neither is one that belongs to a lane
//              still building
//   leftAlone  what would be a stray but is an interactive shell (a controlling terminal, a login shell,
//              `-i`): the owner's own terminal can sit in a merged worktree, and it is never signalled;
//              a worktree one sits in is kept (`inUse`)
//   warnings   disk under 10 GB free; `lsof` missing (a process is then judged by its executable and script
//              only, so one that merely stands in the run directory is not seen)
//   temps      temp files of an atomic write (`fs/atomic.mjs`) whose writer is gone, in the directories
//              Agentry writes whole into (the run state, the run directory itself for start's note and idle
//              records, the lock directories, the root and `.claude/`)
//   slots      lock and gate slots whose holder and riders are gone (`staleLockSlots`, `staleGateSlots`), each
//              with the pgids still running that its runs left behind; a take with no pid within its until
//              is held, and never listed
//   writeLocks slot write mutexes left behind: their owner is gone, or they are older than any write
// `apply` then stops the strays (each with its whole descendant tree, and its process group when it leads one;
// what it signals is listed with the stray, a live lane's process is spared, every listed stray is frozen
// before any is killed, and it confirms all of it is gone; strays that appeared while it ran are named for a
// second pass),
// stops each slot's leftover groups the same way and then frees the slot (one whose group survives is kept),
// removes the temp files and write mutexes that are still dead, and removes the cleanable worktrees (through `worktree.remove`, which keeps a dirty one and any branch with
// unlanded work; one holding ignored files that are not disposable is kept unless `discardIgnored`). Nothing else is ever touched.
// Node built-ins only.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, rmSync, statfsSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { deadTemps } from "../fs/atomic.mjs";
import * as drafts from "../process/drafts.mjs";
import { branchTips, worktrees } from "../process/git.mjs";
import * as ledgers from "../process/ledger.mjs";
import {
  OLD_TEMP,
  clearGateSlot,
  gateLockDir,
  groupRunning,
  staleGateSlots,
  staleWriteLocks,
  takeOverMutex,
} from "./gate-lock.mjs";
import { ignoredIn } from "./land.mjs";
import { clearLockSlot, deadLockTemps, lockDirs, staleLockSlots } from "./named-lock.mjs";
import { remove, worktreesDir } from "./worktree.mjs";

const GB = 1024 ** 3;
export const LOW_DISK = 10 * GB;
const SETTLE_MS = 2000;
// How many times a freeze looks again for members a stopped tree still names.
const FREEZE_ROUNDS = 20;
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

// `{ pid, ppid, pgid, tty, stat, command }` for every process on the machine except this one and its whole
// ancestor chain (whatever ran the sweep may itself sit under the run directory, and is never ours to stop).
// `tty`: it has a controlling terminal.
function processes() {
  const res = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,tty=,stat=,command="], {
    encoding: "utf8",
  });
  if (res.status !== 0) return [];
  const all = res.stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      tty: !["??", "?", "-"].includes(m[4]),
      stat: m[5],
      command: m[6],
    }));
  const parent = new Map(all.map((p) => [p.pid, p.ppid]));
  const mine = new Set();
  for (let pid = process.pid; pid > 1 && !mine.has(pid); pid = parent.get(pid)) mine.add(pid);
  return all.filter((p) => !mine.has(p.pid));
}

// Whether `p` is on a controlling terminal or is a login shell (`-zsh`): the owner's own, whatever started it.
const onTerminal = (p) => p.tty || p.command.split(/\s+/)[0].startsWith("-");

// Whether `p` is a shell run `-i`: only the options before the script or `-c` operand count (`sh run.sh -i`
// hands `-i` to the script).
function runsInteractive(p) {
  const [exe, ...args] = p.command.split(/\s+/);
  if (!SHELLS.includes(basename(exe))) return false;
  for (const a of args) {
    if (!a.startsWith("-") || a === "--") return false;
    if (/^-[a-zA-Z]*i[a-zA-Z]*$/.test(a)) return true;
    if (/^-[a-zA-Z]*c/.test(a)) return false;
  }
  return false;
}

// The owner's terminal, for a process found under the run directory: on a terminal, a login shell or run `-i`.
const interactive = (p) => onTerminal(p) || runsInteractive(p);

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

// Whether a lane still building owns `p`, by its footprint: it stands in the lane's worktree or run files.
// It claims a process even where a finished ledger does too (a merged ledger whose worktree is the repo root
// contains everything).
const ownedByLive = (root, all, p, cwd) => {
  const feet = footprint(p, cwd.get(p.pid));
  return all.some(
    (l) =>
      !FINISHED.includes(l.state) && laneDirs(root, l).some((d) => feet.some((f) => within(f, d))),
  );
};

// The processes started under the run directory that no live lane owns: `{ strays, leftAlone, lsofMissing }`.
function findStrays(root, all) {
  const dir = join(root, ".agentry", "run");
  const run = [...new Set([dir, real(dir)])];
  const cwd = cwds();
  const found = { strays: [], leftAlone: [], lsofMissing: cwd.missing };
  const procs = processes();
  const owned = (q) => ownedByLive(root, all, q, cwd.map);
  for (const p of procs) {
    const feet = footprint(p, cwd.map.get(p.pid));
    if (!feet.some((f) => run.some((r) => within(f, r)))) continue;
    if (owned(p)) continue;
    if (interactive(p))
      found.leftAlone.push({
        pid: p.pid,
        command: p.command,
        reason: "interactive shell",
        cwd: cwd.map.get(p.pid),
      });
    else {
      const also = reach(p, procs, owned);
      found.strays.push({
        pid: p.pid,
        command: p.command,
        with: procs
          .filter((q) => q.pid !== p.pid && also.has(q.pid))
          .map((q) => ({ pid: q.pid, command: q.command })),
      });
    }
  }
  return found;
}

// The directories outside the lock ones that Agentry writes whole into, each with the older temp naming
// once written there (or none): the run state (start's records sit in the run directory itself), and the
// instruction files' (the root and `.claude/`).
const tempDirs = (root) => [
  [join(root, ".agentry", "run")],
  [join(root, ".agentry", "run", "process"), drafts.OLD_TEMP],
  [join(root, ".agentry", "run", "process", "ledger"), ledgers.OLD_TEMP],
  [gateLockDir(root), OLD_TEMP],
  [root],
  [join(root, ".claude")],
];

/** What killed writers and holders left in the repo whose main checkout is `root`: `{ temps, slots,
 *  writeLocks }` (see above). `slots` are `{ file, lock, slot, groups }`, `lock` "gate" for a gate slot.
 *  Only looks. */
export function leftovers(root) {
  return {
    temps: [...tempDirs(root).flatMap(([dir, old]) => deadTemps(dir, old)), ...deadLockTemps(root)],
    slots: [
      ...staleGateSlots(gateLockDir(root)).map((s) => ({ ...s, lock: "gate" })),
      ...staleLockSlots(root),
    ],
    writeLocks: [gateLockDir(root), ...lockDirs(root)].flatMap(staleWriteLocks),
  };
}

/** What a sweep would do in the repo whose main checkout is `root`. `free` overrides the disk reading;
 *  `disposable` is the process file's `cleanup.disposable`, on top of `DEFAULT_DISPOSABLE`. */
export function plan(root, { free = freeBytes(root), disposable = [] } = {}) {
  // Listed before anything reads the ledgers, and read without sweeping: the preview changes nothing.
  const left = leftovers(root);
  const all = ledgers.list(root, { sweep: false });
  const cleanable = [];
  const unknown = [];
  for (const tree of worktrees(root)) {
    if (!tree.path.startsWith(worktreesDir(root) + sep)) continue;
    const ledger = all.find(
      (l) => l.worktree === tree.path || (tree.branch && l.branch === tree.branch),
    );
    if (!ledger) unknown.push({ path: tree.path, branch: tree.branch });
    else if (ledger.state === "merged" || ledger.state === "closed") {
      const found = ignoredIn(tree.path, disposable);
      cleanable.push({
        id: ledger.id,
        path: tree.path,
        branch: tree.branch,
        ...found,
        inUse: false,
      });
    }
  }
  const { strays, leftAlone, lsofMissing } = findStrays(root, all);
  for (const w of cleanable) {
    const dirs = [w.path, real(w.path)];
    w.inUse = leftAlone.some((p) => p.cwd && dirs.some((d) => within(p.cwd, d)));
  }
  const warnings = [];
  if (free !== null && free < LOW_DISK)
    warnings.push(`only ${(free / GB).toFixed(1)} GB free on the disk (below ${LOW_DISK / GB} GB)`);
  if (lsofMissing)
    warnings.push("lsof not found: a process that only stands in the run directory can't be seen");
  return { cleanable, unknown, strays, leftAlone, diskFree: free, warnings, ...left };
}

// The pids among `pids` still running (a zombie is dead).
const stillRunning = (pids) =>
  processes()
    .filter((p) => pids.has(p.pid) && !p.stat.startsWith("Z"))
    .map((p) => p.pid);

// This sweep's own process group.
const ownGroup = () =>
  Number(spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout);

// What sweep can prove is `stray`'s, among `procs`: the stray, everything below it and, only when the stray
// leads its process group (pgid == pid), the rest of that group (a double-forked child keeps the group). A
// stray that merely sits in someone else's group takes nothing of it: the group's other members are not
// ours to name. Never a terminal or a login shell, nor what hangs under one, never a process `owned` by a
// lane still building, nor what hangs under that; never a group that holds a terminal or this sweep.
// `led` remembers whether the stray led its group when first seen (the group outlives its leader).
function reach(stray, procs, owned, led = {}) {
  const self = procs.find((p) => p.pid === stray.pid);
  led.group ??= self && self.pgid === self.pid ? self.pid : null;
  const members = new Set([stray.pid]);
  if (led.group) {
    const mates = procs.filter((p) => p.pgid === led.group);
    const shared =
      mates.some((p) => onTerminal(p) || runsInteractive(p)) || led.group === ownGroup();
    if (!shared) for (const p of mates) members.add(p.pid);
  }
  for (const top of [...members]) for (const pid of treeOf(top, procs)) members.add(pid);
  for (const p of procs)
    if (members.has(p.pid) && p.pid !== stray.pid && (onTerminal(p) || owned(p)))
      for (const pid of treeOf(p.pid, procs)) members.delete(pid);
  return members;
}

// A signaller that records each pid it reached in `signalled`: false when the pid is gone already.
const signalTo = (signalled) => (pid, name) => {
  try {
    process.kill(pid, name);
    signalled.add(pid);
    return true;
  } catch {
    return false; // already gone
  }
};

// Freeze: SIGSTOP every member `reach` names and every child of a member, looking again until no new member
// appears (a stopped process cannot fork, so nothing escapes the way a child forked in a SIGTERM handler, its
// parent gone at once, would). `cwd` is the working directories read once for the whole sweep. Returns
// `{ members, signalled }`, every pid frozen among the members: `kill` ends them all.
function freeze(stray, root, all, cwd) {
  const members = new Set([stray.pid]);
  const signalled = new Set();
  const frozen = new Set();
  const led = {};
  const owned = (p) => ownedByLive(root, all, p, cwd);
  const signal = signalTo(signalled);
  for (let round = 0; round < FREEZE_ROUNDS; round++) {
    const procs = processes();
    for (const pid of reach(stray, procs, owned, led)) members.add(pid);
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of procs)
        if (members.has(p.ppid) && !members.has(p.pid) && !onTerminal(p) && !owned(p)) {
          members.add(p.pid);
          grew = true;
        }
    }
    const fresh = stillRunning(members).filter((pid) => !frozen.has(pid));
    if (!fresh.length) break;
    for (const pid of fresh) if (signal(pid, "SIGSTOP")) frozen.add(pid);
  }
  return { members, signalled };
}

// Kill what `freeze` froze: SIGKILL every member still running, and confirm they are gone. Returns `{ left,
// signalled }`: the pids still running afterwards, and every pid that was signalled.
function kill({ members, signalled }) {
  const signal = signalTo(signalled);
  for (const pid of stillRunning(members)) signal(pid, "SIGKILL");
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < SETTLE_MS; waited += 100) {
    if (!stillRunning(members).length) return { left: [], signalled: [...signalled] };
    Atomics.wait(nap, 0, 0, 100);
  }
  return { left: stillRunning(members), signalled: [...signalled] };
}

// Stop the group `pgid` a dead run left running, as a stray is stopped: frozen (SIGSTOP), so no member forks
// a way out, then SIGKILL; never a group that holds a terminal or an interactive shell, or this sweep. True
// when it is gone.
function stopGroup(pgid) {
  const mates = processes().filter((p) => p.pgid === pgid);
  if (pgid === ownGroup() || mates.some(interactive)) return !groupRunning(pgid);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (const signal of ["SIGSTOP", "SIGKILL"])
    try {
      process.kill(-pgid, signal);
    } catch {
      return true; // gone already
    }
  for (let waited = 0; waited < SETTLE_MS; waited += 100) {
    if (!groupRunning(pgid)) return true;
    Atomics.wait(nap, 0, 0, 100);
  }
  return !groupRunning(pgid);
}

// Do what `found` lists of the leftovers, judged again now: only what is still stale and was listed goes.
function clearLeftovers(root, found, done) {
  const now = leftovers(root);
  const listed = (file, list) => list.some((x) => (x.file ?? x) === file);
  for (const s of now.slots.filter((s) => listed(s.file, found.slots ?? []))) {
    const left = s.groups.filter((pgid) => !stopGroup(pgid));
    done.stoppedGroups.push(...s.groups.filter((pgid) => !left.includes(pgid)));
    done.survivingGroups.push(...left);
    const cleared =
      !left.length && (s.lock === "gate" ? clearGateSlot(s.file) : clearLockSlot(s.file));
    if (cleared) done.freedSlots.push(s.file);
    else
      done.keptSlots.push({
        file: s.file,
        reason: left.length ? `group ${left.join(", ")} still running` : "taken again since",
      });
  }
  for (const file of now.writeLocks.filter((f) => listed(f, found.writeLocks ?? [])))
    if (takeOverMutex(file)) done.removedWriteLocks.push(file);
  // A listed temp file a read has swept since (the ledgers' own reads do) is gone too; one whose pid runs
  // again is left.
  for (const file of found.temps ?? [])
    if (now.temps.includes(file) || !existsSync(file)) {
      rmSync(file, { force: true });
      done.removedTemps.push(file);
    }
}

/** Do what `found` (a `plan`) lists: `{ removed: [{ id, branchDeleted, branchKept? }], kept: [{ id, reason }], killed: [pid],
 *  gone: [pid], survived: [pid], survivors: [pid], signalled: [pid] }`. `branchKept` says why a removed worktree's
 *  branch stayed (`kept <b>: it has a case twin <other>` / `kept <b>: work not on main`), in the plan's `warnings`
 *  too. A worktree `worktree.remove` keeps, or one holding
 *  ignored files while `discardIgnored` is off, is `kept` with its reason; a process already gone is `gone`;
 *  a stray with anything of its tree still running after SIGKILL is `survived` (its pid), the pids still
 *  running are `survivors`, and every pid that got a signal is `signalled`. Of the leftovers: `freedSlots` and
 *  `keptSlots: [{ file, reason }]`, the slots' groups as `stoppedGroups` and `survivingGroups`, and the
 *  `removedWriteLocks` and `removedTemps`; `appeared`, the strays found after the kill that the plan did not
 *  list (the plan's `warnings` then say to run the sweep again). */
export function apply(root, found, { discardIgnored = false } = {}) {
  const done = {
    removed: [],
    kept: [],
    killed: [],
    gone: [],
    survived: [],
    survivors: [],
    signalled: [],
    freedSlots: [],
    keptSlots: [],
    stoppedGroups: [],
    survivingGroups: [],
    removedWriteLocks: [],
    removedTemps: [],
    appeared: [],
  };
  // Every listed stray is frozen before any is killed: a stray stopped late (another's kill, or the time
  // the others take) could fork a way out meanwhile, or react to the others' end. Each listed pid is
  // stopped at once, then each tree in full; strays found after it all are named for a second pass.
  // One `ps` for all of them, and the first stops before anything slow (the ledgers, lsof): a fast forker
  // forks out for as long as that takes.
  const running = new Set(stillRunning(new Set(found.strays.map((p) => p.pid))));
  const live = found.strays.filter((p) => running.has(p.pid));
  done.gone.push(...found.strays.filter((p) => !running.has(p.pid)).map((p) => p.pid));
  const first = new Set();
  const stopFirst = signalTo(first);
  for (const p of live) stopFirst(p.pid, "SIGSTOP");
  const all = ledgers.list(root);
  const cwd = live.length ? cwds().map : new Map();
  const frozen = live.map((p) => ({ p, ...freeze(p, root, all, cwd) }));
  for (const { p, members, signalled } of frozen) {
    if (first.has(p.pid)) signalled.add(p.pid);
    const { left, signalled: sent } = kill({ members, signalled });
    done.signalled.push(...sent);
    if (left.length) {
      done.survived.push(p.pid);
      done.survivors.push(...left);
    } else done.killed.push(p.pid);
  }
  if (live.length) {
    const listed = new Set([...found.strays.map((p) => p.pid), ...done.signalled]);
    const appeared = findStrays(root, ledgers.list(root)).strays.filter((p) => !listed.has(p.pid));
    done.appeared = appeared.map((p) => p.pid);
    // The sweep's CLI prints the plan's warnings after the result: the second pass is said there.
    if (appeared.length)
      found.warnings.push(`run lane sweep --apply again: ${appeared.length} appeared while it ran`);
  }
  clearLeftovers(root, found, done);
  for (const w of found.cleanable) {
    const why = keepReason(w, discardIgnored);
    if (why) {
      done.kept.push({ id: w.id, reason: why });
      continue;
    }
    const res = remove(root, { path: w.path, branch: w.branch });
    if (!res.removed) {
      done.kept.push({ id: w.id, reason: res.reason });
      continue;
    }
    const branchKept = res.reason ? keptBranch(root, w.branch) : null;
    done.removed.push({
      id: w.id,
      branchDeleted: res.branchDeleted,
      ...(branchKept && { branchKept }),
    });
    // Said with the plan's warnings too, which the sweep's CLI prints after the result.
    if (branchKept) found.warnings.push(branchKept);
  }
  return done;
}

// Why `worktree.remove` kept `branch` once its worktree went: a case twin (deleting by name could take the
// twin with it), else work that is not on main.
function keptBranch(root, branch) {
  const folded = branch.toLowerCase();
  const twin = [...branchTips(root).keys()].find((b) => b !== branch && b.toLowerCase() === folded);
  return twin ? `kept ${branch}: it has a case twin ${twin}` : `kept ${branch}: work not on main`;
}

/** Why a cleanable worktree stays (a shell is in it, or it holds ignored files), or null when it can go. */
export function keepReason(w, discardIgnored) {
  if (w.inUse) return "in use by a shell";
  if (w.ignored?.length && !discardIgnored)
    return `holds ${w.ignored.length} ignored file(s) removal would delete (${w.ignored.slice(0, 3).join(", ")}); --discard-ignored to remove it anyway`;
  return null;
}
