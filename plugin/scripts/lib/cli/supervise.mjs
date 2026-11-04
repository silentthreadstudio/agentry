// supervise — runs one command in a process group of its own under a time limit: stdio inherited, the
// group gets SIGTERM at the limit and SIGKILL `GRACE_KILL_MS` later (grandchildren too), and the exit is
// the command's own, 124 at the limit, 127 when it could not start. SIGINT, SIGTERM and SIGHUP sent to
// this process are forwarded to the group. `agentry run` (run.mjs) wraps it with the locks. Node built-ins only.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { groupRunning } from "../lane/gate-lock.mjs";
import { say } from "./help.mjs";

/** The exit of a command stopped at its limit, as `timeout(1)` gives it. */
export const LIMIT_EXIT = 124;
/** How long a group has between SIGTERM and SIGKILL. */
export const GRACE_KILL_MS = 5000;

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const signalGroup = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // the group is gone already
  }
};

/**
 * Run `cmd` (argv, no shell) in its own group under `limitMs`: a promise of the exit code `agentry run`
 * ends with. `onStart(pgid)` is called once the command has started, with its process group.
 */
export function supervise(cmd, limitMs, limitText, { onStart } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", detached: true });
    let timedOut = false;
    let killTimer = null;
    const forward = (signal) => signalGroup(child.pid, signal);
    const limitTimer = setTimeout(() => {
      timedOut = true;
      signalGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), GRACE_KILL_MS);
    }, limitMs);
    const finish = (code) => {
      clearTimeout(limitTimer);
      clearTimeout(killTimer);
      for (const signal of FORWARDED) process.off(signal, forward);
      done(code);
    };
    child.on("error", (error) => {
      process.stderr.write(
        `${say("run", `cannot start ${cmd[0]}: ${error.code ?? error.message}`)}\n`,
      );
      finish(127);
    });
    child.on("exit", async (code, signal) => {
      if (!timedOut) {
        clearTimeout(limitTimer);
        // A group the command left behind is not waited on; only a stopped one is cleared.
        return finish(code ?? 128 + (constants.signals[signal] ?? 0));
      }
      // Stopped at the limit: the grandchildren go too, at SIGKILL time if they outlive SIGTERM.
      while (groupRunning(child.pid)) await sleep(50);
      process.stderr.write(
        `${say("run", `${cmd[0]} hit the --limit ${limitText} and was stopped`)}\n`,
      );
      finish(LIMIT_EXIT);
    });
    for (const signal of FORWARDED) process.on(signal, forward);
    if (child.pid !== undefined) onStart?.(child.pid);
  });
}
