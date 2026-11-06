// pid — a process named so that a reused pid does not pass for it. A record keeps `{ pid, start }`: the pid
// and the process's start time (`/proc/<pid>/stat` on Linux, else `ps -o lstart=`), and `alive` holds only
// while that pid runs AND started then. A record with no `start` (written before there was one, or when the
// start could not be read) is read by its pid alone, as before. A process group is named by its leader:
// `groupAlive(pgid, start)` holds while a member runs and the leader is either that same process or gone (a
// live group's id is never given out again, but a leader's pid is once the whole group is gone). Both err
// toward alive: a start that cannot be read while the pid runs is no proof of another process.
// Node built-ins only.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Is `pid` a running process (a zombie too)? EPERM means it is, and is not ours to signal. */
export function running(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Does any process of group `pgid` still run? */
export function groupRunning(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The start time of `pid` as a string, or null when it is gone or cannot be read. Field 22 of
// /proc/<pid>/stat counts after the command name, which may itself hold spaces and parentheses. `ps
// -o lstart` prints local time in the locale's words: TZ and LC_ALL are pinned, so every process (whatever
// its own TZ) reads the same text for the same process.
function startOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (start) return start;
  } catch {
    // no /proc here, or no such process: ps says which
  }
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const text = ps.status === 0 ? ps.stdout.trim().replace(/\s+/g, " ") : "";
  return text || null;
}

let own = null;

/** `{ pid, start }` of process `pid` (`start` null when it cannot be read: such a record is a bare pid). */
export function identity(pid = process.pid) {
  if (pid === process.pid) {
    own ??= { pid, start: startOf(pid) };
    return own;
  }
  return { pid, start: Number.isInteger(pid) && pid > 0 ? startOf(pid) : null };
}

/** Is the process `id` names still that process: its pid runs, and with a `start`, it started then. A
 *  start that cannot be read now (no `ps`, a failed spawn) while the pid runs reads alive: only a start that
 *  was read and differs means another process, so a live holder is never freed for want of a reading. */
export function alive(id) {
  if (!running(id?.pid)) return false;
  if (typeof id.start !== "string") return true;
  const now = startOf(id.pid);
  return now === null || now === id.start;
}

/** Does the group `pgid` whose leader started at `start` still run? Its leader's pid run by another
 *  process means the group is gone (that pid could not be given out while it lived). */
export function groupAlive(pgid, start) {
  if (!groupRunning(pgid)) return false;
  if (typeof start !== "string" || !running(pgid)) return true;
  const now = startOf(pgid);
  return now === null || now === start;
}
