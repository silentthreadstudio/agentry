// Tests for lib/process/pid.mjs: a process is named by its pid and its start time, so a pid given out again
// to another process does not pass for the one recorded; a record with no start is read by its pid.
// Run: node --test plugin/scripts/test/pid.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { alive, groupAlive, identity } from "../lib/process/pid.mjs";

const NODE = process.execPath;
const children = [];
after(() => {
  for (const child of children) child.kill("SIGKILL");
});

// A process that runs until the test ends: `{ pid, end() }`, `detached` leading its own group.
function sleeper({ detached = false } = {}) {
  const child = spawn(NODE, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached });
  children.push(child);
  const gone = new Promise((resolve) => child.on("exit", resolve));
  return {
    pid: child.pid,
    end: () => {
      child.kill("SIGKILL");
      return gone;
    },
  };
}
const deadPid = () => spawnSync(NODE, ["-e", ""]).pid;

test("identity names a running process by its pid and its start, and that identity is alive", () => {
  const { pid } = sleeper();
  const id = identity(pid);
  assert.equal(id.pid, pid);
  assert.equal(typeof id.start, "string");
  assert.ok(id.start.length > 0);
  assert.deepEqual(identity(pid), id, "the same process gives the same start");
  assert.equal(alive(id), true);
});

test("a fake identity with the right pid and a wrong start reads dead: a reused pid is not the holder", () => {
  const { pid } = sleeper();
  assert.equal(alive({ pid, start: "Thu Jan  1 00:00:00 1970" }), false);
  assert.equal(alive({ pid: process.pid, start: "not when this one started" }), false);
  assert.equal(alive(identity()), true, "this process's own identity is alive");
});

test("a pid that has ended reads dead, with or without a start; a record with no start is read by its pid", async () => {
  const proc = sleeper();
  const id = identity(proc.pid);
  await proc.end();
  assert.equal(alive(id), false);
  assert.equal(alive({ pid: deadPid() }), false);
  assert.equal(alive({ pid: process.pid }), true, "no start: its pid alone");
  assert.equal(identity(deadPid()).start, null, "a gone process has no start to read");
  assert.equal(alive(null), false);
});

test("a group is alive while it runs under the leader it was recorded with, and not once it is gone", async () => {
  const leader = sleeper({ detached: true });
  const { start } = identity(leader.pid);
  assert.equal(groupAlive(leader.pid, start), true);
  assert.equal(groupAlive(leader.pid, undefined), true, "no start: by its pgid alone");
  assert.equal(groupAlive(leader.pid, "another leader's start"), false, "its id now names another");
  await leader.end();
  assert.equal(groupAlive(leader.pid, start), false);
});

// `code` run as an ES module with pid.mjs imported as `pid`, under time zone `tz`: its stdout.
function underTz(tz, code) {
  const url = JSON.stringify(new URL("../lib/process/pid.mjs", import.meta.url).href);
  const res = spawnSync(
    NODE,
    ["--input-type=module", "-e", `import * as pid from ${url};\n${code}`],
    {
      encoding: "utf8",
      env: { ...process.env, TZ: tz },
    },
  );
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

test("an identity recorded under one time zone reads alive under another", () => {
  const { pid } = sleeper();
  const recorded = underTz("UTC", `console.log(JSON.stringify(pid.identity(${pid})))`);
  for (const tz of ["Asia/Tokyo", "America/Los_Angeles"])
    assert.equal(underTz(tz, `console.log(pid.alive(${recorded}))`), "true", `checked under ${tz}`);
  assert.equal(
    underTz(
      "Asia/Tokyo",
      `console.log(pid.groupAlive(${pid}, ${JSON.stringify(JSON.parse(recorded).start)}))`,
    ),
    "false",
    "not a group leader: no group",
  );
});
