// Tests for lib/lane/named-lock.mjs and the `agentry lock` group (take, drop, show): slots up to the
// capacity, a take that ends at its ttl or when its session's pid is gone, a session taking again, and the
// refusals. Run: node --test plugin/scripts/test/named-lock.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dropLock, heldLocks, lockDir, releaseLock, tryLock } from "../lib/lane/named-lock.mjs";
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
  assert.equal(
    dropLock(dir, "sim", { slots: 2, pid: process.pid, who: "run" }),
    0,
    "a run is no take",
  );
  assert.equal(dropLock(dir, "sim", { slots: 2, pid: process.pid, who: "T-1" }), 1);
  assert.deepEqual(readdirSync(lockDir(dir, "sim")), ["slot-2.lock"]);
});
