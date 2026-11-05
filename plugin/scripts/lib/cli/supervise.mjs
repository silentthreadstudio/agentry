// supervise — runs one command in a process group of its own under a time limit: stdio inherited, the
// group gets SIGTERM at the limit and SIGKILL `GRACE_KILL_MS` later (grandchildren too), and the exit is
// the command's own, 124 at the limit, 127 or 126 when it could not start. However the command ends, what
// is left of its group is killed before the promise settles. `agentry run` (run.mjs) wraps it with the locks.
// The command starts held: `/bin/sh` waits on fd 3 until `onStart` has recorded the group in the slots,
// then `exec`s the argv as given (no shell parsing; same pid, so the same group). Should this process die
// before that (even by SIGKILL), fd 3 closes, the shell ends and the command never runs: no slot ever reads
// free while its command runs. The command is looked up first (`startError`, as exec does: a path as given,
// a bare name on PATH), so one that cannot start exits 127 (not found) or 126 (not executable) with the same
// line on every platform, whatever its sh would say.
//
// One handler set for the whole process, installed once (`onEnd`): what is registered runs once when the
// process exits (normally or on a thrown error) or gets SIGINT, SIGTERM or SIGHUP. A signal while a command
// runs is forwarded to its group (SIGKILL follows `GRACE_KILL_MS` later), and the run ends once the command
// has; a signal with no command running runs what is registered and exits 128 + the signal. SIGKILL can't
// be caught: what it leaves, the next taker and `agentry lane sweep` free.
//
// The watchdog mode, for a process that cannot handle signals while it waits (a synchronous gate):
//   node supervise.mjs --parent <pid> --start <start> [--free <file>]… -- <cmd> [args…]
// runs the command, stdio inherited, and ends as the command does: its exit code, or the same signal. About
// once a second it looks at the parent (`--start` its start time, so a reused pid does not pass for it);
// once the parent is no longer alive, the command's group goes and each `--free` slot file the dead parent
// still holds is freed after it. Started leading its own group (`runGate` starts it detached), it keeps the
// command in that group and records that group (`pgid`, `pgStart`: its own) in each `--free` slot before the
// command starts, so the slot is held whenever the command runs. Whoever started it kills that group when
// the watchdog ends, however it ends, and on the parent's death it leaves a reaper (`--reap <pgid>`,
// outside the group) to free the slots, then kills the group it verified it leads. Not leading one, it gives the command a group of its own and only
// ever signals that group (SIGTERM, a holder's timeout, kills it, then the watchdog ends by SIGKILL).
// `watchdogArgv` builds that argv. Node built-ins only.
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { constants } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freeDeadHolder, recordGroup } from "../lane/gate-lock.mjs";
import { alive, groupRunning, identity } from "../process/pid.mjs";
import { say } from "./help.mjs";

/** The exit of a command stopped at its limit, as `timeout(1)` gives it. */
export const LIMIT_EXIT = 124;
/** How long a group has between SIGTERM and SIGKILL. */
export const GRACE_KILL_MS = 5000;
// How long a killed group's members get to be gone before the run goes on.
const SETTLE_MS = 2000;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
// The held start (see above): a closed fd 3 with no go line (this process died first) ends it unrun.
const HELD = ["-c", 'read -r go <&3 || exit 1; exec 3<&-; exec -- "$@"', "sh"];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const signalGroup = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // the group is gone already
  }
};

const ends = new Set();
// The running command's stop(signal), while there is one.
let stopping = null;
let installed = false;

function endAll() {
  for (const end of [...ends]) {
    ends.delete(end);
    end();
  }
}

function install() {
  if (installed) return;
  installed = true;
  process.on("exit", endAll);
  for (const signal of SIGNALS)
    process.on(signal, () => {
      if (stopping) return stopping(signal);
      endAll();
      process.exit(128 + constants.signals[signal]);
    });
}

/** Run `end` once when this process ends, however it ends (see above); returns the call that unregisters it. */
export function onEnd(end) {
  install();
  ends.add(end);
  return () => ends.delete(end);
}

// Kill what is left of group `pgid` and wait (up to SETTLE_MS) for it to be gone.
async function endGroup(pgid) {
  signalGroup(pgid, "SIGKILL");
  for (let waited = 0; waited < SETTLE_MS && groupRunning(pgid); waited += 20) await sleep(20);
}

// Why `file` cannot be run: "ENOENT" (no such file), "EACCES" (a directory, or not executable), or null.
function unrunnable(file) {
  try {
    if (statSync(file).isDirectory()) return "EACCES";
    accessSync(file, fsConstants.X_OK);
    return null;
  } catch (error) {
    return error.code === "ENOENT" || error.code === "ENOTDIR" ? "ENOENT" : "EACCES";
  }
}

/** Why the command `name` cannot start, as exec would find it (a name with a slash is a path; a bare name
 *  is the first runnable one on PATH, an empty entry the working directory): "ENOENT", "EACCES" (one was
 *  found, none runnable), or null. */
function startError(name) {
  if (!name) return "ENOENT";
  if (name.includes("/")) return unrunnable(name);
  let found = "ENOENT";
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    const why = unrunnable(join(dir || ".", name));
    if (why === null) return null;
    if (why === "EACCES") found = why;
  }
  return found;
}

/**
 * Run `cmd` (argv, no shell) in its own group under `limitMs`: a promise of the exit code `agentry run`
 * ends with. `onStart(pgid)` is called with its process group before the command runs (it is let go once
 * that returns); if it throws, the group is killed unrun and the promise rejects with that error.
 */
export function supervise(cmd, limitMs, limitText, { onStart } = {}) {
  install();
  const why = startError(cmd[0]);
  if (why !== null) {
    process.stderr.write(`${say("run", `cannot start ${cmd[0]}: ${why}`)}\n`);
    return Promise.resolve(why === "ENOENT" ? 127 : 126);
  }
  return new Promise((done, fail) => {
    const child = spawn("/bin/sh", [...HELD, ...cmd], {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      detached: true,
    });
    const go = child.stdio[3];
    go.on("error", () => {}); // the shell is gone already (killed): its exit says the rest
    let timedOut = false;
    let killTimer = null;
    let failed = null;
    let stopped = false;
    const stop = (signal) => {
      stopped = true;
      signalGroup(child.pid, signal);
      killTimer ??= setTimeout(() => signalGroup(child.pid, "SIGKILL"), GRACE_KILL_MS);
    };
    const limitTimer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
    }, limitMs);
    const finish = (code) => {
      clearTimeout(limitTimer);
      clearTimeout(killTimer);
      stopping = null;
      if (failed) fail(failed);
      else done(code);
    };
    child.on("error", (error) => {
      process.stderr.write(
        `${say("run", `cannot start ${cmd[0]}: ${error.code ?? error.message}`)}\n`,
      );
      finish(127);
    });
    child.on("exit", async (code, signal) => {
      clearTimeout(limitTimer);
      // A stopped group has until its SIGKILL to go; whatever a command that ended on its own left goes now.
      if (stopped) while (groupRunning(child.pid)) await sleep(50);
      else await endGroup(child.pid);
      if (!timedOut) return finish(code ?? 128 + (constants.signals[signal] ?? 0));
      process.stderr.write(
        `${say("run", `${cmd[0]} hit the --limit ${limitText} and was stopped`)}\n`,
      );
      finish(LIMIT_EXIT);
    });
    if (child.pid === undefined) return;
    stopping = stop;
    try {
      onStart?.(child.pid);
      go.end("go\n");
    } catch (error) {
      failed = error;
      signalGroup(child.pid, "SIGKILL");
      go.destroy();
    }
  });
}

const WATCHDOG = fileURLToPath(import.meta.url);
const PARENT_POLL_MS = 1000;
// How long a killed command group gets to be gone before the watchdog goes on regardless.
const GROUP_GONE_MS = 5000;

/** The argv that runs `cmd` under the watchdog, bound to `parent` (this process by default), with `free`
 *  the slot files to free should the parent die mid-command. */
export function watchdogArgv(cmd, { parent = identity(), free = [] } = {}) {
  const start = parent.start === null ? [] : ["--start", parent.start];
  const frees = free.flatMap((file) => ["--free", file]);
  return [
    process.execPath,
    WATCHDOG,
    "--parent",
    String(parent.pid),
    ...start,
    ...frees,
    "--",
    ...cmd,
  ];
}

// The watchdog's options: `{ parent, free, reap, cmd }`, or null when they don't make one (a command after
// `--`, or `--reap <pgid>` and none).
function watchArgs(argv) {
  const dash = argv.indexOf("--");
  const opts = dash < 0 ? argv : argv.slice(0, dash);
  const got = {
    parent: { pid: Number.NaN, start: null },
    free: [],
    reap: null,
    cmd: dash < 0 ? [] : argv.slice(dash + 1),
  };
  for (let i = 0; i < opts.length; i += 2) {
    const [name, value] = [opts[i], opts[i + 1]];
    if (value === undefined) return null;
    if (name === "--parent") got.parent.pid = Number(value);
    else if (name === "--start") got.parent.start = value;
    else if (name === "--free") got.free.push(value);
    else if (name === "--reap") got.reap = Number(value);
    else return null;
  }
  if (!Number.isInteger(got.parent.pid)) return null;
  return (got.reap === null ? got.cmd.length > 0 : Number.isInteger(got.reap)) ? got : null;
}

// Does this process lead its process group? Only a group's leader shares its id: a group with this
// process's pid as its id can only be the one it leads.
function leadsGroup() {
  try {
    process.kill(-process.pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The reaper a watchdog leaves behind as it takes its own group down: once group `reap` is gone, it frees
// the dead parent's slots.
async function reap({ reap: pgid, parent, free }) {
  for (let waited = 0; waited < 2 * GROUP_GONE_MS && groupRunning(pgid); waited += 20)
    await sleep(20);
  for (const file of free) freeDeadHolder(file, parent);
}

// The watchdog mode (see the head of this file).
function watch(argv) {
  const args = watchArgs(argv);
  if (!args) {
    process.stderr.write(
      "supervise: --parent <pid> [--start <start>] [--free <file>]… -- <cmd> [args…]\n",
    );
    process.exit(2);
  }
  if (args.reap !== null) return reap(args);
  const { parent, free, cmd } = args;
  // Leading its group (as `runGate` starts it), the watchdog keeps the command in it, so whoever kills
  // the watchdog's group (`runGate`, whenever the watchdog ends) reaches the command too. Otherwise the
  // command gets a group of its own, and that group is all the watchdog ever signals.
  const leader = leadsGroup();
  // A leader's group is the command's: each slot the parent holds records it before the command starts, so
  // the slot is held whenever the command runs, even should the parent and this watchdog both die by SIGKILL
  // (the sweep then stops it).
  if (leader) for (const file of free) recordGroup(file, parent, process.pid);
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", detached: !leader });
  const endChild = async () => {
    if (child.pid === undefined) return;
    signalGroup(child.pid, "SIGKILL");
    for (let waited = 0; waited < GROUP_GONE_MS && groupRunning(child.pid); waited += 20)
      await sleep(20);
  };
  // The parent is gone. A leader's group goes down with it, so a reaper outside the group frees the slots
  // once it is gone; otherwise the command's own group goes and the watchdog frees them itself.
  const orphan = async () => {
    if (leader) {
      const frees = free.flatMap((file) => ["--free", file]);
      const start = parent.start === null ? [] : ["--start", parent.start];
      const pgid = String(process.pid);
      spawn(
        process.execPath,
        [WATCHDOG, "--reap", pgid, "--parent", String(parent.pid), ...start, ...frees],
        {
          detached: true,
          stdio: "ignore",
        },
      ).unref();
      process.kill(-process.pid, "SIGKILL"); // verified above: the group this watchdog leads
      return;
    }
    await endChild();
    for (const file of free) freeDeadHolder(file, parent);
    process.exit(1);
  };
  // Not a leader, the holder's timeout (SIGTERM) must reach the command's own group: it goes, then the
  // watchdog ends by SIGKILL. A leader just dies by it, and its group is killed for it.
  const onTerm = async () => {
    await endChild();
    process.kill(process.pid, "SIGKILL");
  };
  if (!leader) process.on("SIGTERM", onTerm);
  // Once the parent is gone, `orphan` owns the end: the command's own exit must not end this watchdog first.
  let orphaned = false;
  const poll = setInterval(() => {
    if (alive(parent)) return;
    orphaned = true;
    clearInterval(poll);
    orphan();
  }, PARENT_POLL_MS);
  child.on("error", (error) => {
    clearInterval(poll);
    process.stderr.write(`\n[agentry] could not run ${cmd[0]}: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", async (code, signal) => {
    if (orphaned) return;
    clearInterval(poll);
    if (!alive(parent)) return orphan();
    // Whatever the command left of its group goes with it (a leader's group: by whoever started it).
    if (!leader) await endChild();
    if (signal === null) process.exit(code ?? 1);
    process.off("SIGTERM", onTerm);
    process.kill(process.pid, signal); // end by the same signal, as the command did
    // A signal Node ignores or handles here (SIGPIPE, SIGUSR1) did not end the watchdog: say it instead.
    process.stderr.write(`\n[agentry] ${cmd[0]} was killed by ${signal}\n`);
    process.exit(128 + (constants.signals[signal] ?? 0));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  watch(process.argv.slice(2));
