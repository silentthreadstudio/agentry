// Tests for lib/fs/atomic.mjs: a file written whole through `<file>.agentry-<pid>.tmp`, and the sweep of the
// temp files a killed writer leaves (only those whose pid is gone).
// Run: node --test plugin/scripts/test/atomic.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { atomicWrite, deadTemps, sweepTemps, tempOf } from "../lib/fs/atomic.mjs";

const NODE = process.execPath;
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const fresh = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentry-atomic-")));
  dirs.push(dir);
  return dir;
};
const deadPid = () => spawnSync(NODE, ["-e", ""]).pid;

test("atomicWrite writes the file whole, replaces it, and leaves no temp file", () => {
  const dir = fresh();
  const file = join(dir, "state.json");
  atomicWrite(file, "one");
  atomicWrite(file, "two");
  assert.equal(readFileSync(file, "utf8"), "two");
  assert.deepEqual(readdirSync(dir), ["state.json"]);
  assert.equal(tempOf(file), `${file}.agentry-${process.pid}.tmp`);
});

test("a write whose rename fails leaves the target as it was and no temp file", () => {
  const dir = fresh();
  const target = join(dir, "busy");
  mkdirSync(join(target, "inside"), { recursive: true });
  assert.throws(() => atomicWrite(target, "text"));
  assert.deepEqual(readdirSync(dir), ["busy"]);
});

test("a writer killed between write and rename leaves a temp file the next sweep removes", async () => {
  const dir = fresh();
  const url = JSON.stringify(new URL("../lib/fs/atomic.mjs", import.meta.url).href);
  const file = JSON.stringify(join(dir, "ledger.json"));
  // The writer stops between its two steps, as a kill -9 would leave it.
  const writer = spawn(
    NODE,
    [
      "--input-type=module",
      "-e",
      `import { tempOf } from ${url}; import { writeFileSync } from "node:fs";
       writeFileSync(tempOf(${file}), "half"); process.kill(process.pid, "SIGKILL");`,
    ],
    { stdio: "ignore" },
  );
  await new Promise((resolve) => writer.on("exit", resolve));
  assert.deepEqual(readdirSync(dir), [`ledger.json.agentry-${writer.pid}.tmp`]);
  assert.deepEqual(sweepTemps(dir), [join(dir, `ledger.json.agentry-${writer.pid}.tmp`)]);
  assert.deepEqual(readdirSync(dir), []);
});

test("a sweep never removes a temp file whose writer still runs, nor a file that is no temp", () => {
  const dir = fresh();
  const dead = `a.json.agentry-${deadPid()}.tmp`;
  const live = `b.json.agentry-${process.pid}.tmp`;
  for (const name of [dead, live, "c.json", "d.agentry-x.tmp", "e.json.123.tmp"])
    writeFileSync(join(dir, name), "");
  assert.deepEqual(deadTemps(dir), [join(dir, dead)], "listing only");
  assert.equal(readdirSync(dir).length, 5, "a listing removes nothing");
  assert.deepEqual(sweepTemps(dir), [join(dir, dead)]);
  assert.deepEqual(readdirSync(dir).sort(), [live, "c.json", "d.agentry-x.tmp", "e.json.123.tmp"]);
});

test("another naming's leftovers are swept when asked for, and a missing directory has none", () => {
  const dir = fresh();
  const old = `slot-1.lock.${deadPid()}.tmp`;
  writeFileSync(join(dir, old), "");
  assert.deepEqual(sweepTemps(dir), [], "not this naming");
  assert.deepEqual(sweepTemps(dir, /^slot-\d+\.lock\.(\d+)\.tmp$/), [join(dir, old)]);
  assert.deepEqual(sweepTemps(join(dir, "nowhere")), []);
});
