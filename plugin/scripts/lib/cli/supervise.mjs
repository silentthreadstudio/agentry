// supervise — runs one command in a process group of its own under a time limit: stdio inherited, the
// group gets SIGTERM at the limit and SIGKILL `GRACE_KILL_MS` later (grandchildren too), and the exit is
// the command's own, 124 at the limit, 127 when it could not start. However the command ends, what is left
// of its group is killed before the promise settles. `agentry run` (run.mjs) wraps it with the locks.
//
// One handler set for the whole process, installed once (`onEnd`): what is registered runs once when the
// process exits (normally or on a thrown error) or gets SIGINT, SIGTERM or SIGHUP. A signal while a command
// runs is forwarded to its group (SIGKILL follows `GRACE_KILL_MS` later), and the run ends once the command
// has; a signal with no command running runs what is registered and exits 128 + the signal. SIGKILL can't
// be caught: what it leaves, the next taker and `agentry lane sweep` free.
//
// The watchdog mode, for a process that cannot handle signals while it waits (a synchronous gate):
//   node supervise.mjs --parent <pid> --start <start> -- <cmd> [args…]
// runs the command in a process group of its own, stdio inherited, and ends as the command does: its exit
// code, or the same signal, once whatever the command left of its group is killed. About once a second it
// looks at the parent (`--start` its start time, so a reused pid does not pass for it); once the parent is
// no longer alive, it kills the command's group, waits for it to be gone, and frees each `--free` slot file
// the dead parent still holds. SIGTERM (a holder's timeout) kills the command's group, then the watchdog
// ends by SIGKILL. It only ever signals the command's group. `watchdogArgv` builds that argv. Node
// built-ins only.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freeDeadHolder } from "../lane/gate-lock.mjs";
import { alive, groupRunning, identity } from "../process/pid.mjs";
import { say } from "./help.mjs";

/** The exit of a command stopped at its limit, as `timeout(1)` gives it. */
export const LIMIT_EXIT = 124;
/** How long a group has between SIGTERM and SIGKILL. */
export const GRACE_KILL_MS = 5000;
// How long a killed group's members get to be gone before the run goes on.
const SETTLE_MS = 2000;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

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

/**
 * Run `cmd` (argv, no shell) in its own group under `limitMs`: a promise of the exit code `agentry run`
 * ends with. `onStart(pgid)` is called once the command has started, with its process group; if it throws,
 * the group is killed and the promise rejects with that error.
 */
export function supervise(cmd, limitMs, limitText, { onStart } = {}) {
  install();
  return new Promise((done, fail) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", detached: true });
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
    } catch (error) {
      failed = error;
      signalGroup(child.pid, "SIGKILL");
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

// The watchdog's options before `--`: `{ parent, free, cmd }`, or null when they don't make one.
function watchArgs(argv) {
  const dash = argv.indexOf("--");
  if (dash < 0) return null;
  const got = { parent: { pid: Number.NaN, start: null }, free: [], cmd: argv.slice(dash + 1) };
  for (let i = 0; i < dash; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (value === undefined) return null;
    if (name === "--parent") got.parent.pid = Number(value);
    else if (name === "--start") got.parent.start = value;
    else if (name === "--free") got.free.push(value);
    else return null;
  }
  return got.cmd.length && Number.isInteger(got.parent.pid) ? got : null;
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
  const { parent, free, cmd } = args;
  // The command leads a group of its own: the watchdog kills that group and nothing else.
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", detached: true });
  const endChild = async () => {
    if (child.pid === undefined) return;
    signalGroup(child.pid, "SIGKILL");
    for (let waited = 0; waited < GROUP_GONE_MS && groupRunning(child.pid); waited += 20)
      await sleep(20);
  };
  // The holder ran out of time (`runGate`'s timeout sends SIGTERM): the command's group goes, then this
  // watchdog ends by SIGKILL, as the command did before it ran under one.
  const onTerm = async () => {
    await endChild();
    process.kill(process.pid, "SIGKILL");
  };
  process.on("SIGTERM", onTerm);
  // Once the parent is gone, the cleanup below owns the end: the command's own exit must not end this
  // watchdog before the slots are freed.
  let orphaned = false;
  const poll = setInterval(async () => {
    if (alive(parent)) return;
    orphaned = true;
    clearInterval(poll);
    await endChild();
    for (const file of free) freeDeadHolder(file, parent);
    process.exit(1);
  }, PARENT_POLL_MS);
  child.on("error", (error) => {
    clearInterval(poll);
    process.stderr.write(`\n[agentry] could not run ${cmd[0]}: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", async (code, signal) => {
    if (orphaned) return;
    clearInterval(poll);
    await endChild(); // whatever it left of its group goes with it
    if (!alive(parent)) for (const file of free) freeDeadHolder(file, parent);
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
