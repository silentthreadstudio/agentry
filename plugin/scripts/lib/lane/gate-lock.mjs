// gate-lock — lanes queue their gates (`gate.concurrency`, default 1) so load-sensitive tests never run
// against each other. A slot is a file `slot-<n>.lock` in a directory under `.agentry/run/`, created with
// `wx` (one creator wins) and holding the pid of the process that took it. A slot whose pid is gone is
// stale: the next taker removes it and takes the slot, so a killed lane never blocks the queue.
// `exclusive` takes every slot (in order, so two of them cannot deadlock): a flaky re-run runs alone.
// Synchronous, like `runGate`. Node built-ins only.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const POLL_MS = 200;

const slotFile = (dir, n) => join(dir, `slot-${n}.lock`);

// Is `pid` a running process? EPERM means it is, and is not ours to signal.
function running(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const holderOf = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

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
    // A file with no readable pid is one being written right now: leave it for the next poll.
    if (!holder || running(holder.pid)) return false;
    if (holderOf(file)?.pid === holder.pid) rmSync(file, { force: true });
  }
  return false;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Wait for a gate slot in `dir` (`slots` of them; `exclusive`: all of them) for up to `waitSec`.
 * `{ release }` once held (call it when the gate is done), or `{ busy: { pid, who } }` when the wait ran
 * out, naming the holder of the slot that never came free.
 */
export function holdGate(dir, { slots = 1, exclusive = false, who = "", waitSec = 3600 } = {}) {
  mkdirSync(dir, { recursive: true });
  const held = [];
  const release = () => {
    for (const n of held.splice(0)) {
      const file = slotFile(dir, n);
      if (holderOf(file)?.pid === process.pid) rmSync(file, { force: true });
    }
  };
  const deadline = Date.now() + waitSec * 1000;
  const wanted = exclusive ? Array.from({ length: slots }, (_, i) => i + 1) : null;
  for (;;) {
    if (exclusive) {
      for (const n of wanted.slice(held.length)) {
        if (!take(dir, n, who)) break;
        held.push(n);
      }
      if (held.length === slots) return { release };
    } else {
      for (let n = 1; n <= slots; n++)
        if (take(dir, n, who)) {
          held.push(n);
          return { release };
        }
    }
    if (Date.now() >= deadline) {
      const blocking = holderOf(slotFile(dir, exclusive ? held.length + 1 : 1));
      release();
      return { busy: { pid: blocking?.pid ?? null, who: blocking?.who ?? "" } };
    }
    sleep(POLL_MS);
  }
}
