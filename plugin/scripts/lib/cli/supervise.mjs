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
// runs the command in the watchdog's own process group (start the watchdog detached), stdio inherited, and
// ends as the command does: its exit code, or the same signal. About once a second it looks at the parent
// (`--start` its start time, so a reused pid does not pass for it); once the parent is no longer alive, it
// kills the whole group, itself included. `watchdogArgv` builds that argv. Node built-ins only.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/** The argv that runs `cmd` under the watchdog, bound to `parent` (this process by default). */
export function watchdogArgv(cmd, parent = identity()) {
  const start = parent.start === null ? [] : ["--start", parent.start];
  return [process.execPath, WATCHDOG, "--parent", String(parent.pid), ...start, "--", ...cmd];
}

// The watchdog mode (see the head of this file).
function watch(argv) {
  const dash = argv.indexOf("--");
  const opts = argv.slice(0, dash);
  const cmd = argv.slice(dash + 1);
  const value = (name) => (opts.includes(name) ? opts[opts.indexOf(name) + 1] : undefined);
  const parent = { pid: Number(value("--parent")), start: value("--start") ?? null };
  if (dash < 0 || !cmd.length || !Number.isInteger(parent.pid)) {
    process.stderr.write("supervise: --parent <pid> [--start <start>] -- <cmd> [args…]\n");
    process.exit(2);
  }
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
  const poll = setInterval(() => {
    if (!alive(parent)) process.kill(0, "SIGKILL"); // the whole group, this watchdog with it
  }, PARENT_POLL_MS);
  child.on("error", (error) => {
    clearInterval(poll);
    process.stderr.write(`\n[agentry] could not run ${cmd[0]}: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    clearInterval(poll);
    if (signal === null) process.exit(code ?? 1);
    process.kill(process.pid, signal); // end by the same signal, as the command did
    process.exit(128 + (constants.signals[signal] ?? 0));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  watch(process.argv.slice(2));
