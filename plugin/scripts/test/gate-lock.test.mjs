// Tests for lib/lane/gate-lock.mjs: the queue lanes' gates wait in (slots, exclusive, stale-pid recovery).
// Run: node --test plugin/scripts/test/gate-lock.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { holdGate } from "../lib/lane/gate-lock.mjs";

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
