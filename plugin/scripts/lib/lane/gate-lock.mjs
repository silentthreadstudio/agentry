// gate-lock — lanes queue their gates (`gate.concurrency`, default 1) so load-sensitive tests never run
// against each other. A slot is a file `slot-<n>.lock` in a directory under `.agentry/run/`, holding the
// identity (`pid`, `start`: `process/pid.mjs`) of the process that took it and, once its command starts, that
// command's group (`pgid`, `pgStart`). A slot is created whole (a temp file linked in: one creator wins) and
// rewritten whole (a temp file renamed over it), always inside its write mutex `slot-<n>.lock.write`
// (`serialized`, shared with named-lock), so no reader sees one empty or cut short. A slot whose holder is
// gone (its pid ended, or now names another process) and whose group is gone is stale: the next taker takes
// it over, so a killed lane never blocks the queue. `exclusive` takes every slot (in order, so two of them
// cannot deadlock): a flaky re-run runs alone. A lock file with no readable pid (empty, cut short, written by
// an older version) is stale once it is `GRACE_MS` old. `staleGateSlots` lists for the sweep the slots whose
// holder is gone, `clearGateSlot` removes one; every reader sweeps the dead writers' temp files first.
// Synchronous, like `runGate`. Node built-ins only. The holder and clock primitives are shared with
// `named-lock.mjs` (the workflow file's `locks`).
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite, sweepTemps, tempOf } from "../fs/atomic.mjs";
import { alive, groupAlive, identity } from "../process/pid.mjs";

export { groupRunning, running } from "../process/pid.mjs";

/** How often a waiting taker looks again, and how old a lock file with no readable pid must be to be stale. */
export const POLL_MS = 200;
export const GRACE_MS = 2000;

/** The directory every gate (a lane's, and the land's own on main) queues in. */
export const gateLockDir = (root) => join(root, ".agentry", "run", "gate-locks");

const slotFile = (dir, n) => join(dir, `slot-${n}.lock`);

/** The temp files a slot write before `fs/atomic.mjs` left (`slot-<n>.lock.<pid>.tmp`, in a gate or lock
 *  directory): swept like the atomic helper's own. */
export const OLD_TEMP = /^slot-\d+\.lock\.(\d+)\.tmp$/;

/** The parsed content of a lock file, or null when it is missing or not JSON. */
export const holderOf = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Does the holder a record names (`pid`, `start`) still run as that same process? */
export const holderAlive = (record) => alive({ pid: record?.pid, start: record?.start });

/** The group a record names (`pgid`, `pgStart`), when a member of it still runs: its pgid, else null. */
export const liveGroup = (record) =>
  groupAlive(record?.pgid, record?.pgStart) ? record.pgid : null;

/** A record of this process (or `pid`): `{ pid, start }`, `start` left out when it cannot be read. */
export function recordOf(pid = process.pid) {
  const { start } = identity(pid);
  return start === null ? { pid } : { pid, start };
}

// A lock file nobody can be holding: no readable pid, and old enough not to be mid-write.
function orphaned(file) {
  try {
    return !Number.isInteger(holderOf(file)?.pid) && Date.now() - statSync(file).mtimeMs > GRACE_MS;
  } catch {
    return false;
  }
}

const textOf = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** Create `file` holding `text`, whole, only when it is not there: true when this call made it. The text
 *  goes to a temp file first, then is linked in (as exclusive as `wx`), so no reader ever sees it empty. */
export function createWhole(file, text) {
  const tmp = tempOf(file);
  try {
    writeFileSync(tmp, text);
    linkSync(tmp, file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
}

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Is the write mutex `file` left behind: its owner is no longer alive, or it is older than any write
 *  (`GRACE_MS`)? It holds `{ pid, start, token }`; one in the older `<pid> <token>` form is read by its pid. */
export function staleMutex(file) {
  const text = textOf(file);
  if (text === null) return false;
  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
    owner = null;
  }
  if (owner === null || typeof owner !== "object") owner = { pid: Number.parseInt(text, 10) };
  if (Number.isInteger(owner.pid) && !holderAlive(owner)) return true;
  try {
    return Date.now() - statSync(file).mtimeMs > GRACE_MS;
  } catch {
    return false;
  }
}

/** Take a stale write mutex out of the way by rename, never by compare-then-delete: it is renamed to this
 *  process's temp name, and what was renamed is judged again. Still stale: removed. A live one that took the
 *  stale one's place meanwhile: linked back (unless a newer one is there already). True when one was removed. */
export function takeOverMutex(mutex) {
  const grab = tempOf(mutex);
  try {
    renameSync(mutex, grab);
  } catch {
    return false; // gone already: another taker took it over
  }
  const stale = staleMutex(grab);
  // Known, accepted race: a live mutex renamed away here, and a third taker creating a new one before the
  // link-back below, lets two writers overlap. It takes three contenders within microseconds of a stale
  // mutex.
  if (!stale)
    try {
      linkSync(grab, mutex);
    } catch {
      // a newer mutex is there: it stands
    }
  rmSync(grab, { force: true });
  return stale;
}

/** Run `fn` as the only writer of slot `file`: every read-modify-write of a slot runs inside its write mutex
 *  `<file>.write` (created whole, holding this process's identity and a token), so no rewrite loses another's.
 *  A mutex left behind is taken over (`takeOverMutex`). */
export function serialized(file, fn) {
  const mutex = `${file}.write`;
  const mine = JSON.stringify({ ...recordOf(), token: Math.random() });
  for (;;) {
    try {
      if (createWhole(mutex, mine)) break;
    } catch (error) {
      if (error.code === "ENOENT") return fn(); // its directory is gone: nothing to serialize against
      throw error;
    }
    if (!(staleMutex(mutex) && takeOverMutex(mutex))) nap(2);
  }
  try {
    return fn();
  } finally {
    // Known, accepted race (like the takeover's above): this release compares, then deletes its own mutex.
    // A hold that outlasted GRACE_MS may have been taken over meanwhile, and the delete can then remove the
    // newcomer's mutex. Holds last a few ms; it needs one past two seconds.
    if (textOf(mutex) === mine) rmSync(mutex, { force: true });
  }
}

/** The write mutexes in `dir` left behind (`staleMutex`), for the sweep; `takeOverMutex` removes one. */
export function staleWriteLocks(dir) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => /^slot-\d+\.lock\.write$/.test(f))
    .map((f) => join(dir, f))
    .filter(staleMutex);
}

// Is gate slot `file` (read as `holder`) held by nobody: its holder and its command's group are gone, or it
// has no readable pid and is old?
const staleGate = (file, holder) =>
  Number.isInteger(holder?.pid)
    ? !holderAlive(holder) && liveGroup(holder) === null
    : orphaned(file);

// Take slot `n`: true when this process now holds it. A slot held by nobody is taken over, inside its mutex.
function take(dir, n, label) {
  const file = slotFile(dir, n);
  const mine = JSON.stringify({ ...recordOf(), who: label, at: new Date().toISOString() });
  return serialized(file, () => {
    if (createWhole(file, mine)) return true;
    if (!staleGate(file, holderOf(file))) return false;
    atomicWrite(file, mine);
    return true;
  });
}

// The gate slot files in `dir`, by number.
function slotNumbers(dir) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .map((f) => /^slot-(\d+)\.lock$/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((x, y) => x - y);
}

/** The gate slots in `dir` nobody holds any more: `[{ file, slot, groups }]`, `groups` the pgid still
 *  running of a slot whose holder died while its command lives on (the sweep stops it). */
export function staleGateSlots(dir) {
  return slotNumbers(dir).flatMap((slot) => {
    const file = slotFile(dir, slot);
    const holder = holderOf(file);
    const dead = Number.isInteger(holder?.pid) ? !holderAlive(holder) : orphaned(file);
    if (!dead) return [];
    const group = liveGroup(holder);
    return [{ file, slot, groups: group === null ? [] : [group] }];
  });
}

/** Remove the gate slot `file` when nobody holds it any more (its holder and its group are gone), inside its
 *  mutex: true when it was removed. */
export function clearGateSlot(file) {
  return serialized(file, () => {
    if (textOf(file) === null || !staleGate(file, holderOf(file))) return false;
    rmSync(file, { force: true });
    return true;
  });
}

// The slot files this process holds: its gate slots, and the lock slots of its runs (named-lock). A
// synchronous gate hands them to its watchdog (`runGate`), which frees them if this process dies mid-gate.
const ownSlots = new Set();

/** The slot files this process holds now. */
export const slotsHeldHere = () => [...ownSlots];

/** Note that this process now holds slot `file` (`held`), or no longer does. */
export function heldHere(file, held) {
  if (held) ownSlots.add(file);
  else ownSlots.delete(file);
}

/** Free slot `file` when process `parent` (an identity) held it and both it and the group it recorded are
 *  gone, inside its mutex: a watchdog's cleanup after its parent died. True when it was removed. */
export function freeDeadHolder(file, parent) {
  return serialized(file, () => {
    const holder = holderOf(file);
    if (holder?.pid !== parent.pid) return false;
    const other =
      typeof holder.start === "string" &&
      typeof parent.start === "string" &&
      holder.start !== parent.start;
    if (other || holderAlive(holder) || liveGroup(holder) !== null) return false;
    rmSync(file, { force: true });
    return true;
  });
}

/** An ISO time as local HH:MM (`?` when it is not a time). */
export const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "?"
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The slots in `dir` a running process holds now: `[{ slot, pid, who, since }]` (`since` is HH:MM). */
export function heldSlots(dir) {
  sweepTemps(dir, OLD_TEMP);
  return slotNumbers(dir).flatMap((slot) => {
    const holder = holderOf(slotFile(dir, slot));
    return holderAlive(holder) || liveGroup(holder) !== null
      ? [{ slot, pid: holder.pid, who: holder.who ?? "", since: clock(holder.at) }]
      : [];
  });
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Wait for a gate slot in `dir` (`slots` of them; `exclusive`: all of them) for up to `waitSec`.
 * `{ release, group }` once held (call `group(pgid)` when the command starts, `release` when it is done;
 * `waited` says the slot was not free at first), or
 * `{ busy: { pid, who } }` when the wait ran out, naming the holder of the slot that never came free and its
 * lock file. With `log` (a file path), a wait is written there at once: `waiting for gate slot N (held by
 * <who> since HH:MM)`, then `slot acquired`; the gate that follows appends to the same file. `onNote(line)`
 * is told the same lines.
 */
export function holdGate(
  dir,
  { slots = 1, exclusive = false, who = "", waitSec = 3600, log = null, onNote = null } = {},
) {
  mkdirSync(dir, { recursive: true });
  sweepTemps(dir, OLD_TEMP);
  const held = [];
  // A slot whose command left a group running stays held (its pid is gone, its group is not).
  const release = () => {
    for (const n of held.splice(0)) {
      const file = slotFile(dir, n);
      serialized(file, () => {
        const holder = holderOf(file);
        if (holder?.pid === process.pid && liveGroup(holder) === null)
          rmSync(file, { force: true });
      });
      heldHere(file, false);
    }
  };
  // Record the process group of the command that runs under the slots held, by its leader's identity.
  const group = (pgid) => {
    const { start } = identity(pgid);
    for (const n of held) {
      const file = slotFile(dir, n);
      serialized(file, () => {
        const holder = holderOf(file);
        if (holder?.pid !== process.pid) return;
        const group = { pgid, ...(start !== null && { pgStart: start }) };
        atomicWrite(file, JSON.stringify({ ...holder, ...group }));
      });
    }
  };
  const deadline = Date.now() + waitSec * 1000;
  let waited = false;
  const note = (line) => {
    onNote?.(line);
    if (!log) return;
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, `[agentry] ${line}\n`);
  };
  const wanted = exclusive ? Array.from({ length: slots }, (_, i) => i + 1) : null;
  const arrived = () => {
    if (waited) note("slot acquired");
    return { release, group, waited };
  };
  for (;;) {
    if (exclusive) {
      for (const n of wanted.slice(held.length)) {
        if (!take(dir, n, who)) break;
        held.push(n);
        heldHere(slotFile(dir, n), true);
      }
      if (held.length === slots) return arrived();
    } else {
      for (let n = 1; n <= slots; n++)
        if (take(dir, n, who)) {
          held.push(n);
          heldHere(slotFile(dir, n), true);
          return arrived();
        }
    }
    if (Date.now() >= deadline) {
      const file = slotFile(dir, exclusive ? held.length + 1 : 1);
      const blocking = holderOf(file);
      release();
      return { busy: { pid: blocking?.pid ?? null, who: blocking?.who ?? "", file } };
    }
    if (!waited) {
      waited = true;
      const n = exclusive ? held.length + 1 : 1;
      const holder = holderOf(slotFile(dir, n));
      note(
        `waiting for gate slot ${n} (held by ${holder?.who || "unknown"} since ${clock(holder?.at)})`,
      );
    }
    sleep(POLL_MS);
  }
}
