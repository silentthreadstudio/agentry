// gate-lock — lanes queue their gates (`gate.concurrency`, default 1) so load-sensitive tests never run
// against each other. A slot is a file `slot-<n>.lock` in a directory under `.agentry/run/`, created with
// `wx` (one creator wins) and holding the pid of the process that took it. A slot whose pid is gone is
// stale: the next taker removes it and takes the slot, so a killed lane never blocks the queue.
// `exclusive` takes every slot (in order, so two of them cannot deadlock): a flaky re-run runs alone.
// A lock file with no readable pid (empty, cut short, unreadable) is stale once it is `GRACE_MS` old: a
// younger one may be a taker between create and write. Synchronous, like `runGate`. Node built-ins only.
// The pid, holder and clock primitives are shared with `named-lock.mjs` (the workflow file's `locks`).
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** How often a waiting taker looks again, and how old a lock file with no readable pid must be to be stale. */
export const POLL_MS = 200;
export const GRACE_MS = 2000;

/** The directory every gate (a lane's, and the land's own on main) queues in. */
export const gateLockDir = (root) => join(root, ".agentry", "run", "gate-locks");

const slotFile = (dir, n) => join(dir, `slot-${n}.lock`);

/** Is `pid` a running process? EPERM means it is, and is not ours to signal. */
export function running(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** The parsed content of a lock file, or null when it is missing or not JSON. */
export const holderOf = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// A lock file nobody can be holding: no readable pid, and old enough not to be mid-write.
function orphaned(file) {
  try {
    return !Number.isInteger(holderOf(file)?.pid) && Date.now() - statSync(file).mtimeMs > GRACE_MS;
  } catch {
    return false;
  }
}

// Take slot `n`: true when this process now holds it. A slot held by a dead pid is taken over.
function take(dir, n, who) {
  const file = slotFile(dir, n);
  const mine = JSON.stringify({ pid: process.pid, who, at: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, mine, { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const holder = holderOf(file);
    // A file with no readable pid may be one being written right now: it goes only once it is old.
    if (!Number.isInteger(holder?.pid)) {
      if (!orphaned(file)) return false;
      rmSync(file, { force: true });
    } else {
      if (running(holder.pid)) return false;
      if (holderOf(file)?.pid === holder.pid) rmSync(file, { force: true });
    }
  }
  return false;
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
    .sort((x, y) => x - y)
    .flatMap((slot) => {
      const holder = holderOf(slotFile(dir, slot));
      return running(holder?.pid)
        ? [{ slot, pid: holder.pid, who: holder.who ?? "", since: clock(holder.at) }]
        : [];
    });
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Wait for a gate slot in `dir` (`slots` of them; `exclusive`: all of them) for up to `waitSec`.
 * `{ release }` once held (call it when the gate is done; `waited` says the slot was not free at first), or
 * `{ busy: { pid, who } }` when the wait ran out, naming the holder of the slot that never came free and its
 * lock file. With `log` (a file path), a wait is written there at once: `waiting for gate slot N (held by
 * <who> since HH:MM)`, then `slot acquired`; the gate that follows appends to the same file.
 */
export function holdGate(
  dir,
  { slots = 1, exclusive = false, who = "", waitSec = 3600, log = null } = {},
) {
  mkdirSync(dir, { recursive: true });
  const held = [];
  const release = () => {
    for (const n of held.splice(0)) {
      const file = slotFile(dir, n);
      if (holderOf(file)?.pid === process.pid) rmSync(file, { force: true });
    }
  };
  const deadline = Date.now() + waitSec * 1000;
  let waited = false;
  const note = (line) => {
    if (!log) return;
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, `[agentry] ${line}\n`);
  };
  const wanted = exclusive ? Array.from({ length: slots }, (_, i) => i + 1) : null;
  const arrived = () => {
    if (waited) note("slot acquired");
    return { release, waited };
  };
  for (;;) {
    if (exclusive) {
      for (const n of wanted.slice(held.length)) {
        if (!take(dir, n, who)) break;
        held.push(n);
      }
      if (held.length === slots) return arrived();
    } else {
      for (let n = 1; n <= slots; n++)
        if (take(dir, n, who)) {
          held.push(n);
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
