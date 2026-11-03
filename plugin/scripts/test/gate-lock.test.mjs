// Tests for lib/lane/gate-lock.mjs: the queue lanes' gates wait in (slots, exclusive, stale-pid recovery).
// Run: node --test plugin/scripts/test/gate-lock.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { heldSlots, holdGate } from "../lib/lane/gate-lock.mjs";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const lockDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gate-lock-")));
  temps.push(dir);
  return join(dir, "locks");
};
const slots = (dir) => readdirSync(dir).sort();

test("one slot: a second taker finds it busy, naming the holder; release frees it", () => {
  const dir = lockDir();
  const first = holdGate(dir, { who: "lane A" });
  assert.ok(first.release);
  const second = holdGate(dir, { who: "lane B", waitSec: 0 });
  assert.deepEqual(second.busy, {
    pid: process.pid,
    who: "lane A",
    file: join(dir, "slot-1.lock"),
  });
  first.release();
  assert.deepEqual(slots(dir), []);
  const third = holdGate(dir, { who: "lane C", waitSec: 0 });
  assert.ok(third.release);
  third.release();
});

test("two slots: two gates hold at once, the third waits", () => {
  const dir = lockDir();
  const a = holdGate(dir, { slots: 2 });
  const b = holdGate(dir, { slots: 2 });
  assert.deepEqual(slots(dir), ["slot-1.lock", "slot-2.lock"]);
  assert.ok(holdGate(dir, { slots: 2, waitSec: 0 }).busy);
  a.release();
  const c = holdGate(dir, { slots: 2, waitSec: 0 });
  assert.ok(c.release);
  b.release();
  c.release();
});

test("exclusive takes every slot, and is refused while any one is held", () => {
  const dir = lockDir();
  const one = holdGate(dir, { slots: 2 });
  const alone = holdGate(dir, { slots: 2, exclusive: true, waitSec: 0 });
  assert.ok(alone.busy);
  assert.deepEqual(slots(dir), ["slot-1.lock"], "a refused exclusive leaves no slot behind");
  one.release();
  const all = holdGate(dir, { slots: 2, exclusive: true, waitSec: 0 });
  assert.deepEqual(slots(dir), ["slot-1.lock", "slot-2.lock"]);
  assert.ok(holdGate(dir, { slots: 2, waitSec: 0 }).busy);
  all.release();
  assert.deepEqual(slots(dir), []);
});

test("a slot left by a process that is gone is taken over", async () => {
  const dir = lockDir();
  holdGate(dir, { waitSec: 0 }).release();
  const child = spawn(process.execPath, ["-e", "0"]);
  await new Promise((done) => child.on("exit", done));
  writeFileSync(
    join(dir, "slot-1.lock"),
    JSON.stringify({ pid: child.pid, who: "lane dead", at: "t" }),
  );
  const taken = holdGate(dir, { who: "lane live", waitSec: 0 });
  assert.ok(taken.release, "the dead holder's slot was recovered");
  taken.release();
  assert.equal(existsSync(join(dir, "slot-1.lock")), false);
});

test("release leaves a slot another process now holds alone", () => {
  const dir = lockDir();
  const mine = holdGate(dir);
  writeFileSync(join(dir, "slot-1.lock"), JSON.stringify({ pid: process.ppid, who: "other" }));
  mine.release();
  assert.ok(existsSync(join(dir, "slot-1.lock")));
});

const plant = (dir, text, ageSec) => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "slot-1.lock");
  writeFileSync(file, text);
  const at = new Date(Date.now() - ageSec * 1000);
  utimesSync(file, at, at);
  return file;
};

test("an old empty or unreadable lock file is stale and taken over", () => {
  for (const text of ["", "{not json", '{"who":"no pid"}']) {
    const dir = lockDir();
    plant(dir, text, 60);
    const taken = holdGate(dir, { waitSec: 0 });
    assert.ok(taken.release, `taken over: ${JSON.stringify(text)}`);
    taken.release();
    assert.deepEqual(slots(dir), []);
  }
});

test("a young empty lock file may be mid-write: it is left, and a refusal names the file", () => {
  const dir = lockDir();
  const file = plant(dir, "", 0);
  const res = holdGate(dir, { waitSec: 0 });
  assert.deepEqual(res.busy, { pid: null, who: "", file });
  assert.ok(existsSync(file));
});

// A lock held by another running process (`ms` of life), as a queued gate finds it. The process is
// started through a shell that leaves it behind, so it is reaped when it ends (a child of this test would
// stay a zombie while the test waits, and a zombie still counts as running).
function heldElsewhere(dir, who, ms = 30000) {
  const res = spawnSync(
    "sh",
    [
      "-c",
      `${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, ${ms})' >/dev/null 2>&1 & echo $!`,
    ],
    { encoding: "utf8" },
  );
  const pid = Number(res.stdout.trim());
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "slot-1.lock"),
    JSON.stringify({ pid, who, at: new Date().toISOString() }),
  );
  return {
    pid,
    kill: (signal) => {
      try {
        process.kill(pid, signal);
      } catch {}
    },
  };
}

test("a wait is written to the log at once: the slot, who holds it and since when", () => {
  const dir = lockDir();
  const log = join(dir, "..", "logs", "gate-1.log");
  const holder = heldElsewhere(dir, "lane T9");
  try {
    const res = holdGate(dir, { who: "lane T1", waitSec: 0.3, log });
    assert.ok(res.busy);
    assert.match(
      readFileSync(log, "utf8"),
      /^\[agentry\] waiting for gate slot 1 \(held by lane T9 since \d\d:\d\d\)\n$/,
    );
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a wait that ends with the slot writes slot acquired after the waiting line", () => {
  const dir = lockDir();
  const log = join(dir, "..", "logs", "gate-1.log");
  const holder = heldElsewhere(dir, "lane T9", 700);
  const res = holdGate(dir, { who: "lane T1", waitSec: 10, log });
  assert.ok(res.release);
  assert.equal(res.waited, true);
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /waiting for gate slot 1 \(held by lane T9/);
  assert.equal(lines[1], "[agentry] slot acquired");
  res.release();
  holder.kill("SIGKILL");
});

test("a free slot writes nothing to the log", () => {
  const dir = lockDir();
  const log = join(dir, "..", "logs", "gate-1.log");
  const res = holdGate(dir, { log });
  assert.equal(res.waited, false);
  assert.equal(existsSync(log), false);
  res.release();
});

test("heldSlots lists the slots running processes hold, not a dead one's", () => {
  const dir = lockDir();
  const holder = heldElsewhere(dir, "lane A");
  const dead = spawnSync(process.execPath, ["-e", "0"]);
  writeFileSync(join(dir, "slot-2.lock"), JSON.stringify({ pid: dead.pid, who: "lane B" }));
  try {
    const held = heldSlots(dir);
    assert.deepEqual(
      held.map((h) => [h.slot, h.who, h.pid]),
      [[1, "lane A", holder.pid]],
    );
    assert.match(held[0].since, /^\d\d:\d\d$/);
    assert.deepEqual(heldSlots(join(dir, "nowhere")), []);
  } finally {
    holder.kill("SIGKILL");
  }
});
