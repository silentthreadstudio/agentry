// Tests for lib/lane/named-lock.mjs and the `agentry lock` group (take, drop, show): slots up to the
// capacity, a take that ends at its ttl or when its session's pid is gone, a session taking again, and the
// refusals. Run: node --test plugin/scripts/test/named-lock.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  dropLock,
  dropOrphans,
  endRide,
  heldLocks,
  lockDir,
  releaseLock,
  rideTake,
  setGroup,
  tryLock,
} from "../lib/lane/named-lock.mjs";
import { tempRepo } from "./git-repo.mjs";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(PLUGIN, "bin", "agentry");
const NODE = process.execPath;
const cleanups = [];
after(() => {
  for (const done of cleanups) done();
});

function repo(locks = { editor: 1 }) {
  const { dir, cleanup } = tempRepo();
  cleanups.push(cleanup);
  mkdirSync(join(dir, ".agentry"), { recursive: true });
  writeFileSync(join(dir, ".agentry", "workflow.json"), JSON.stringify({ locks }));
  return dir;
}

// The CLI's env with `CLAUDE_PID` set to `session` (or unset: a take with no session, ttl only).
const envWith = (session) => {
  const { CLAUDE_PID, ...env } = process.env;
  return session ? { ...env, CLAUDE_PID: String(session) } : env;
};
const lock = (dir, args, session) =>
  spawnSync(NODE, [BIN, "lock", ...args], { cwd: dir, encoding: "utf8", env: envWith(session) });
// `agentry lock|run …` in the background: a promise of `{ status, stdout, stderr, ms }`.
function later(dir, args, session) {
  const started = Date.now();
  const child = spawn(NODE, [BIN, ...args], { cwd: dir, env: envWith(session) });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  return new Promise((resolve) =>
    child.on("close", (status) => resolve({ status, stdout, stderr, ms: Date.now() - started })),
  );
}
// A process standing for a host session: `{ pid, end() }`.
function session() {
  const child = spawn(NODE, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const gone = new Promise((resolve) => child.on("exit", resolve));
  cleanups.push(() => child.kill("SIGKILL"));
  return {
    pid: child.pid,
    end: () => {
      child.kill("SIGKILL");
      return gone;
    },
  };
}
const HHMM = "\\d\\d:\\d\\d";

test("take, show and drop: a take is listed with its holder and ttl, and drop frees it", () => {
  const dir = repo();
  const host = session();
  const taken = lock(dir, ["take", "editor", "--for", "T-1"], host.pid);
  assert.equal(taken.status, 0, taken.stderr);
  assert.match(
    taken.stdout,
    new RegExp(`^lock editor taken by T-1 until ${HHMM} → agentry lock drop editor --for T-1\\n$`),
  );
  const shown = lock(dir, ["show"]);
  assert.equal(shown.status, 0);
  assert.match(
    shown.stdout,
    new RegExp(
      `^editor 1/1\\n {2}slot 1: T-1 since ${HHMM}, until ${HHMM} \\(pid ${host.pid}\\)\\n$`,
    ),
  );
  const dropped = lock(dir, ["drop", "editor", "--for", "T-1"], host.pid);
  assert.equal(dropped.status, 0);
  assert.equal(dropped.stdout, "lock editor dropped\n");
  assert.equal(lock(dir, ["show"]).stdout, "editor 0/1: free\n");
  const again = lock(dir, ["drop", "editor", "--for", "T-1"], host.pid);
  assert.equal(again.status, 1);
  assert.match(
    again.stdout,
    /^✗ agentry lock drop: editor is not held by T-1 → agentry lock show\n$/,
  );
});

test("a drop by another lane or session leaves the take in place", () => {
  const dir = repo();
  const host = session();
  assert.equal(lock(dir, ["take", "editor", "--for", "T-1"], host.pid).status, 0);
  assert.equal(lock(dir, ["drop", "editor", "--for", "T-2"], host.pid).status, 1);
  assert.equal(lock(dir, ["drop", "editor", "--for", "T-1"], session().pid).status, 1);
  assert.match(lock(dir, ["show"]).stdout, /^editor 1\/1\n/);
});

test("a take holds off a run until its ttl ends", async () => {
  const dir = repo();
  assert.equal(lock(dir, ["take", "editor", "--for", "T-1", "--ttl", "2s"]).status, 0);
  const run = await later(dir, ["run", "--limit", "20s", "--lock", "editor", "--", NODE, "-e", ""]);
  assert.equal(run.status, 0);
  assert.match(
    run.stderr,
    new RegExp(
      `^waiting for lock editor \\(held by T-1 since ${HHMM}\\)\\nlock editor acquired\\n$`,
    ),
  );
  assert.ok(run.ms >= 1500, `waited ${run.ms} ms`);
});

test("a take ends when its session's pid is gone, long before its ttl", async () => {
  const dir = repo();
  const host = session();
  assert.equal(lock(dir, ["take", "editor", "--for", "T-1", "--ttl", "30m"], host.pid).status, 0);
  const waiting = later(dir, ["lock", "take", "editor", "--for", "T-2"]);
  await new Promise((r) => setTimeout(r, 600));
  await host.end();
  const taken = await waiting;
  assert.equal(taken.status, 0);
  assert.match(
    taken.stderr,
    /^waiting for lock editor \(held by T-1 since .*\)\nlock editor acquired\n$/,
  );
  assert.match(lock(dir, ["show"]).stdout, /slot 1: T-2 since/);
});

test("a take gives up after --wait: exit 75 naming the holder, and takes nothing", () => {
  const dir = repo();
  const host = session();
  assert.equal(lock(dir, ["take", "editor", "--for", "T-1"], host.pid).status, 0);
  const started = Date.now();
  const busy = lock(dir, ["take", "editor", "--for", "T-2", "--wait", "1s"], host.pid);
  assert.equal(busy.status, 75);
  assert.match(
    busy.stderr,
    new RegExp(
      `^waiting for lock editor \\(held by T-1 since ${HHMM}\\)\\n✗ lock take: lock editor busy \\(held by T-1 since ${HHMM}\\) → agentry lock show\\n$`,
    ),
  );
  assert.ok(Date.now() - started >= 950);
  assert.match(lock(dir, ["show"]).stdout, /^editor 1\/1\n {2}slot 1: T-1 since/);
});

test("the same session taking again for the same lane keeps its slot, with no wait", () => {
  const dir = repo();
  const host = session();
  assert.equal(lock(dir, ["take", "editor", "--for", "T-1"], host.pid).status, 0);
  const again = lock(dir, ["take", "editor", "--for", "T-1", "--ttl", "1h"], host.pid);
  assert.equal(again.status, 0);
  assert.equal(again.stderr, "");
  assert.match(lock(dir, ["show"]).stdout, /^editor 1\/1\n/);
});

test("an undeclared lock, a bad --ttl and a missing name are refused with exit 2", () => {
  const dir = repo();
  for (const args of [
    ["take", "sim"],
    ["drop", "sim"],
    ["take", "editor", "--ttl", "0s"],
    ["take", "editor", "--ttl", "x"],
    ["take", "editor", "--wait", "0s"],
    ["drop", "editor", "--wait", "1s"],
    ["take"],
    ["show", "editor"],
    ["take", "editor", "--wait"],
    ["grab", "editor"],
  ]) {
    const run = lock(dir, args);
    assert.equal(run.status, 2, args.join(" "));
    assert.match(run.stderr, /^✗ agentry lock/, args.join(" "));
  }
  assert.equal(lock(dir, ["show"]).stdout, "editor 0/1: free\n", "nothing was taken");
});

test("show with no locks declared says how to add one", () => {
  const { dir, cleanup } = tempRepo();
  cleanups.push(cleanup);
  const shown = lock(dir, ["show"]);
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /^no locks in .*workflow\.json → add "locks": \{ "editor": 1 \}/);
});

test("a broken locks entry stops the CLI with the workflow file's problem", () => {
  const dir = repo({ editor: 0 });
  const run = lock(dir, ["show"]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /locks\.editor should be a whole number above 0/);
});

// The library itself, in this process.
test("capacity 2: two holders at once, the third is told who holds it; release frees one", () => {
  const dir = repo({ sim: 2 });
  const a = tryLock(dir, "sim", { slots: 2, who: "A" });
  const b = tryLock(dir, "sim", { slots: 2, who: "B" });
  assert.deepEqual([a.slot, b.slot], [1, 2]);
  const c = tryLock(dir, "sim", { slots: 2, who: "C" });
  assert.equal(c.busy.who, "A");
  assert.match(c.busy.since, new RegExp(`^${HHMM}$`));
  releaseLock(dir, "sim", a.slot);
  assert.equal(tryLock(dir, "sim", { slots: 2, who: "C" }).slot, 1);
  assert.deepEqual(
    heldLocks(dir, "sim", 2).map((h) => h.who),
    ["C", "B"],
  );
  assert.deepEqual(
    heldLocks(dir, "sim", 1).map((h) => h.who),
    ["C"],
    "a slot past the capacity counts for nothing",
  );
});

test("an old unreadable slot file is taken over; a young one may be mid-write and is left", () => {
  const dir = repo();
  const at = lockDir(dir, "editor");
  mkdirSync(at, { recursive: true });
  const file = join(at, "slot-1.lock");
  writeFileSync(file, "");
  assert.ok(tryLock(dir, "editor", { slots: 1 }).busy, "young: left alone");
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  assert.equal(tryLock(dir, "editor", { slots: 1 }).slot, 1, "old: taken over");
});

test("dropLock frees only the takes of that session and who", () => {
  const dir = repo({ sim: 2 });
  tryLock(dir, "sim", { slots: 2, pid: process.pid, who: "T-1", ttlMs: 60_000 });
  tryLock(dir, "sim", { slots: 2, who: "run" });
  assert.deepEqual(
    dropLock(dir, "sim", { slots: 2, pid: process.pid, who: "run" }),
    { dropped: 0, kept: null },
    "a run is no take",
  );
  assert.deepEqual(dropLock(dir, "sim", { slots: 2, pid: process.pid, who: "T-1" }), {
    dropped: 1,
    kept: null,
  });
  assert.deepEqual(readdirSync(lockDir(dir, "sim")), ["slot-2.lock"]);
});

test("a ridden take stays held after a drop until the ride ends, then goes; a ride's end restores the take's own until", () => {
  const dir = repo({ sim: 1 });
  const rider = session();
  const take = { slots: 1, pid: process.pid, who: "T-1" };
  const ride = { slots: 1, session: process.pid, who: "T-1", untilMs: Date.now() + 3_600_000 };
  tryLock(dir, "sim", { ...take, ttlMs: 60_000 });
  assert.equal(rideTake(dir, "sim", { ...ride, pid: rider.pid }), 1);
  assert.ok(heldLocks(dir, "sim", 1)[0].until, "extended");
  endRide(dir, "sim", 1, rider.pid);
  const own = Date.parse(JSON.parse(readFileSync(join(lockDir(dir, "sim"), "slot-1.lock"))).until);
  assert.ok(own < Date.now() + 120_000, "back at its own until");
  rideTake(dir, "sim", { ...ride, pid: rider.pid });
  assert.deepEqual(dropLock(dir, "sim", take), { dropped: 0, kept: { pid: rider.pid } });
  assert.equal(heldLocks(dir, "sim", 1).length, 1, "kept while the rider runs");
  endRide(dir, "sim", 1, rider.pid);
  assert.equal(heldLocks(dir, "sim", 1).length, 0, "gone with the ride");
});

test("a take whose rider died is back at its own until, so it ends at its ttl", async () => {
  const dir = repo({ sim: 1 });
  const rider = session();
  tryLock(dir, "sim", { slots: 1, pid: process.pid, who: "T-1", ttlMs: 500 });
  rideTake(dir, "sim", {
    slots: 1,
    session: process.pid,
    who: "T-1",
    untilMs: Date.now() + 3_600_000,
    pid: rider.pid,
  });
  assert.equal(heldLocks(dir, "sim", 1).length, 1);
  await rider.end();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(heldLocks(dir, "sim", 1).length, 0);
});

test("a take with no session pid refreshes its own slot for the same --for; another --for still waits", () => {
  const dir = repo();
  assert.equal(lock(dir, ["take", "editor", "--for", "T-1"]).status, 0);
  const again = lock(dir, ["take", "editor", "--for", "T-1", "--ttl", "1h", "--wait", "1s"]);
  assert.equal(again.status, 0);
  assert.equal(again.stderr, "", "no wait for itself");
  assert.deepEqual(readdirSync(lockDir(dir, "editor")), ["slot-1.lock"]);
  assert.equal(lock(dir, ["take", "editor", "--for", "T-2", "--wait", "1s"]).status, 75);
});

test("a slot whose run died stays held while its command's group runs, and is free the moment it is gone", async () => {
  const dir = repo();
  const group = spawn(NODE, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    detached: true,
  });
  cleanups.push(() => {
    try {
      process.kill(-group.pid, "SIGKILL");
    } catch {
      // gone already
    }
  });
  const dead = spawnSync(NODE, ["-e", ""]).pid;
  const held = tryLock(dir, "editor", { slots: 1, pid: dead, who: "run" });
  setGroup(dir, "editor", held.slot, group.pid, dead);
  assert.equal(heldLocks(dir, "editor", 1)[0].orphan, group.pid);
  assert.ok(tryLock(dir, "editor", { slots: 1, who: "next" }).busy, "the group still runs");
  const gone = new Promise((resolve) => group.on("exit", resolve));
  process.kill(-group.pid, "SIGKILL");
  await gone;
  assert.deepEqual(heldLocks(dir, "editor", 1), [], "free once the group is gone");
  assert.equal(tryLock(dir, "editor", { slots: 1, who: "next" }).slot, 1);
});

test("rideTake rides only this session's own take for that who: another session's take is left as it is", () => {
  const dir = repo({ sim: 1 });
  tryLock(dir, "sim", { slots: 1, pid: null, who: "OTHER", ttlMs: 60_000 });
  const before = readFileSync(join(lockDir(dir, "sim"), "slot-1.lock"), "utf8");
  const ride = { slots: 1, who: "T-1", untilMs: Date.now() + 3_600_000 };
  assert.equal(rideTake(dir, "sim", { ...ride, session: process.pid }), null, "not this session's");
  assert.equal(rideTake(dir, "sim", { ...ride, session: null }), null, "not this who's");
  assert.equal(readFileSync(join(lockDir(dir, "sim"), "slot-1.lock"), "utf8"), before);
});

for (const how of ["is killed", "ends"])
  test(`a rider whose run ${how} lives on while its command's group runs; the take is back at its own until after`, async () => {
    const dir = repo({ sim: 1 });
    const group = spawn(NODE, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      detached: true,
    });
    const gone = new Promise((resolve) => group.on("exit", resolve));
    cleanups.push(() => {
      try {
        process.kill(-group.pid, "SIGKILL");
      } catch {
        // gone already
      }
    });
    const rider = session();
    tryLock(dir, "sim", { slots: 1, pid: process.pid, who: "T-1", ttlMs: 300 });
    const ride = { slots: 1, session: process.pid, who: "T-1", untilMs: Date.now() + 3_600_000 };
    rideTake(dir, "sim", { ...ride, pid: rider.pid });
    setGroup(dir, "sim", 1, group.pid, rider.pid);
    if (how === "ends") endRide(dir, "sim", 1, rider.pid);
    await rider.end();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(heldLocks(dir, "sim", 1).length, 1, "held past its ttl while the group runs");
    process.kill(-group.pid, "SIGKILL");
    await gone;
    assert.deepEqual(heldLocks(dir, "sim", 1), [], "back at its own until, passed");
  });

test("a take again with a longer ttl while it is ridden lasts to the longer of the two", () => {
  const dir = repo({ sim: 1 });
  const rider = session();
  const take = { slots: 1, pid: process.pid, who: "T-1" };
  tryLock(dir, "sim", { ...take, ttlMs: 60_000 });
  rideTake(dir, "sim", {
    ...take,
    session: process.pid,
    untilMs: Date.now() + 120_000,
    pid: rider.pid,
  });
  tryLock(dir, "sim", { ...take, ttlMs: 7_200_000 });
  const { until } = JSON.parse(readFileSync(join(lockDir(dir, "sim"), "slot-1.lock"), "utf8"));
  assert.ok(Date.parse(until) > Date.now() + 3_600_000, `until ${until}`);
});

// `code` run as an ES module in a child that imports named-lock.mjs as `lock`: a promise of its exit.
function withLock(code) {
  const url = JSON.stringify(new URL("../lib/lane/named-lock.mjs", import.meta.url).href);
  const child = spawn(
    NODE,
    ["--input-type=module", "-e", `import * as lock from ${url};\n${code}`],
    {
      stdio: "inherit",
    },
  );
  cleanups.push(() => child.kill("SIGKILL"));
  return new Promise((resolve) => child.on("exit", resolve));
}

test("a slot file another process keeps rewriting never reads empty or cut short", async () => {
  const dir = repo({ sim: 1 });
  const take = { slots: 1, pid: process.pid, who: "T-1", ttlMs: 60_000 };
  tryLock(dir, "sim", take);
  const file = join(lockDir(dir, "sim"), "slot-1.lock");
  const first = readFileSync(file, "utf8");
  const writer = withLock(
    `const end = Date.now() + 3000;
     while (Date.now() < end) lock.tryLock(${JSON.stringify(dir)}, "sim", ${JSON.stringify(take)});`,
  );
  const started = Date.now();
  while (readFileSync(file, "utf8") === first && Date.now() - started < 5000);
  let torn = 0;
  for (const end = Date.now() + 1000; Date.now() < end; ) {
    try {
      JSON.parse(readFileSync(file, "utf8"));
    } catch {
      torn++;
    }
  }
  await writer;
  assert.equal(torn, 0, `${torn} reads saw a slot file mid-write`);
});

test("dropOrphans frees a take whose riders are all gone but leave a group running, naming the pgid; a live rider is refused", async () => {
  const dir = repo({ sim: 1 });
  const group = spawn(NODE, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    detached: true,
  });
  cleanups.push(() => {
    try {
      process.kill(-group.pid, "SIGKILL");
    } catch {
      // gone already
    }
  });
  const rider = session();
  tryLock(dir, "sim", { slots: 1, pid: process.pid, who: "T-1", ttlMs: 60_000 });
  rideTake(dir, "sim", {
    slots: 1,
    session: process.pid,
    who: "T-1",
    untilMs: Date.now() + 60_000,
    pid: rider.pid,
  });
  setGroup(dir, "sim", 1, group.pid, rider.pid);
  assert.deepEqual(dropOrphans(dir, "sim", 1), { freed: [], alive: rider.pid }, "its run lives");
  assert.equal(heldLocks(dir, "sim", 1).length, 1);
  await rider.end();
  assert.deepEqual(dropOrphans(dir, "sim", 1), { freed: [group.pid], alive: null });
  assert.deepEqual(heldLocks(dir, "sim", 1), []);
});
