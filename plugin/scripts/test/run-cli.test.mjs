// Tests for `agentry run` (lib/cli/run.mjs, through plugin/bin/agentry): the command's exit code and
// stdio, its own process group, the time limit (SIGTERM, SIGKILL 5 s later, exit 124), and `--lock`
// against the workflow file's `locks` (waits, never overlaps, freed on any exit and after `kill -9`).
// Run: node --test plugin/scripts/test/run-cli.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gateLockDir, holdGate } from "../lib/lane/gate-lock.mjs";
import { git, tempRepo } from "./git-repo.mjs";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(PLUGIN, "bin", "agentry");
const NODE = process.execPath;
const cleanups = [];
after(() => {
  for (const done of cleanups) done();
});

// A repo whose workflow file declares `locks` (none: no workflow file).
function repo(locks) {
  const { dir, cleanup } = tempRepo();
  cleanups.push(cleanup);
  mkdirSync(join(dir, ".agentry"), { recursive: true });
  if (locks) writeFileSync(join(dir, ".agentry", "workflow.json"), JSON.stringify({ locks }));
  return dir;
}

// The test host's own session pid must not reach the CLI.
const baseEnv = () => {
  const { CLAUDE_PID, ...env } = process.env;
  return env;
};

/** `agentry <args>` in `cwd`: a promise of `{ status, stdout, stderr, ms }`, with the `child` on it. */
function agentry(args, { cwd, env = baseEnv(), input = null, quiet = false } = {}) {
  const started = Date.now();
  const child = spawn(NODE, [BIN, ...args], {
    cwd,
    env,
    stdio: quiet ? "ignore" : [input === null ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += d;
  });
  child.stderr?.on("data", (d) => {
    stderr += d;
  });
  if (input !== null) child.stdin.end(input);
  const done = new Promise((resolve) =>
    child.on(quiet ? "exit" : "close", (status, signal) =>
      resolve({ status, signal, stdout, stderr, ms: Date.now() - started }),
    ),
  );
  return Object.assign(done, { child });
}

const js = (code) => [NODE, "-e", code];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const slots = (dir, name = "editor") => {
  const at = join(dir, ".agentry", "run", "locks", name);
  return existsSync(at) ? readdirSync(at) : [];
};

test("exits with the command's code, its stdin, stdout and stderr its own", async () => {
  const dir = repo();
  const code =
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('out:'+s);process.stderr.write('err');process.exit(3)})";
  const run = await agentry(["run", "--limit", "10s", "--", ...js(code)], {
    cwd: dir,
    input: "in",
  });
  assert.equal(run.status, 3);
  assert.equal(run.stdout, "out:in");
  assert.equal(run.stderr, "err");
});

test("runs the command in a process group of its own", async () => {
  const dir = repo();
  const running = agentry(
    ["run", "--limit", "10s", "--", "sh", "-c", "echo $$ $(ps -o pgid= -p $$)"],
    { cwd: dir },
  );
  const run = await running;
  assert.equal(run.status, 0);
  const [pid, pgid] = run.stdout.trim().split(/\s+/).map(Number);
  assert.equal(pgid, pid, "the command leads its own group");
  assert.notEqual(pid, running.child.pid, "the command is not agentry run itself");
});

test("at the limit the command gets SIGTERM, the message, and exit 124", async () => {
  const dir = repo();
  const log = join(dir, "term.log");
  const code = `process.on('SIGTERM',()=>{require('fs').writeFileSync(${JSON.stringify(log)},'TERM');process.exit(0)});setInterval(()=>{},1000)`;
  const run = await agentry(["run", "--limit", "1s", "--", ...js(code)], { cwd: dir });
  assert.equal(run.status, 124);
  assert.equal(run.stderr, `✗ run: ${NODE} hit the --limit 1s and was stopped\n`);
  assert.equal(readFileSync(log, "utf8"), "TERM");
  assert.ok(run.ms >= 950 && run.ms < 5000, `${run.ms} ms`);
});

test("a command that ignores SIGTERM is killed 5 s after it", async () => {
  const dir = repo();
  const code = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const run = await agentry(["run", "--limit", "1s", "--", ...js(code)], { cwd: dir });
  assert.equal(run.status, 124);
  assert.ok(run.ms >= 5900 && run.ms < 12_000, `${run.ms} ms`);
});

test("a command's grandchildren all go at the limit, one that ignores SIGTERM too", async () => {
  const dir = repo();
  const pids = join(dir, "pids");
  const code = `const {spawn}=require('child_process');
    const a=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const b=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    require('fs').writeFileSync(${JSON.stringify(pids)},a.pid+' '+b.pid);
    process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`;
  const run = await agentry(["run", "--limit", "1s", "--", ...js(code)], { cwd: dir });
  assert.equal(run.status, 124);
  const [a, b] = readFileSync(pids, "utf8").split(" ").map(Number);
  assert.equal(alive(a), false, "the grandchild that took SIGTERM is gone");
  assert.equal(alive(b), false, "the grandchild that ignored SIGTERM is gone");
  assert.ok(run.ms >= 5900, "the run waited for the SIGKILL of the group");
});

test("needs no timeout binary: a PATH with nothing on it still stops the command", async () => {
  const dir = repo();
  const run = await agentry(["run", "--limit", "1s", "--", ...js("setInterval(()=>{},1000)")], {
    cwd: dir,
    env: { PATH: join(dir, "nothing-here") },
  });
  assert.equal(run.status, 124);
});

test("--limit 0s, --limit x, no --limit and no command are refused, and nothing runs", async () => {
  const dir = repo();
  const marker = join(dir, "ran");
  const touch = js(`require('fs').writeFileSync(${JSON.stringify(marker)},'')`);
  for (const args of [
    ["--limit", "0s", "--", ...touch],
    ["--limit", "x", "--", ...touch],
    ["--limit", "5", "--", ...touch],
    ["--", ...touch],
    ["--limit", "5s"],
    ["--limit", "5s", "--"],
  ]) {
    const run = await agentry(["run", ...args], { cwd: dir });
    assert.equal(run.status, 2, args.join(" "));
    assert.match(run.stderr, /^✗ agentry run: .* → agentry run --help\n$/, args.join(" "));
  }
  assert.equal(existsSync(marker), false);
});

test("--lock names a lock the workflow file declares, or is refused with exit 2", async () => {
  const marker = (dir) => js(`require('fs').writeFileSync(${JSON.stringify(join(dir, "ran"))},'')`);
  const declared = repo({ editor: 1 });
  const run = await agentry(["run", "--limit", "5s", "--lock", "sim", "--", ...marker(declared)], {
    cwd: declared,
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no lock "sim" in the locks of .*workflow\.json \(it declares editor\)/);
  const none = repo();
  const bare = await agentry(["run", "--limit", "5s", "--lock", "editor", "--", ...marker(none)], {
    cwd: none,
  });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /it declares no locks/);
  assert.equal(existsSync(join(declared, "ran")) || existsSync(join(none, "ran")), false);
});

test("two runs of one lock of capacity 1 never overlap; the second waits and says so", async () => {
  const dir = repo({ editor: 1 });
  const span = (name) =>
    js(`const fs=require('fs'),f=${JSON.stringify(join(dir, name))};
      fs.writeFileSync(f,Date.now()+' ');setTimeout(()=>fs.appendFileSync(f,String(Date.now())),700)`);
  const runs = await Promise.all(
    ["a", "b"].map((name) =>
      agentry(["run", "--limit", "20s", "--lock", "editor", "--", ...span(name)], { cwd: dir }),
    ),
  );
  assert.deepEqual(
    runs.map((r) => r.status),
    [0, 0],
  );
  const [a, b] = ["a", "b"].map((n) => readFileSync(join(dir, n), "utf8").split(" ").map(Number));
  assert.ok(a[1] <= b[0] || b[1] <= a[0], `overlap: a ${a}, b ${b}`);
  const waited = runs.filter((r) => r.stderr.includes("waiting for lock"));
  assert.equal(waited.length, 1, "exactly one run waited");
  assert.match(
    waited[0].stderr,
    /^waiting for lock editor \(held by node since \d\d:\d\d\)\nlock editor acquired\n$/,
  );
  assert.deepEqual(slots(dir), [], "both released");
});

test("the lock is free again after the command crashes or hits the limit", async () => {
  const dir = repo({ editor: 1 });
  const crash = await agentry(
    ["run", "--limit", "10s", "--lock", "editor", "--", ...js("throw new Error('boom')")],
    { cwd: dir },
  );
  assert.equal(crash.status, 1);
  assert.deepEqual(slots(dir), []);
  const stopped = await agentry(
    ["run", "--limit", "1s", "--lock", "editor", "--", ...js("setInterval(()=>{},1000)")],
    { cwd: dir },
  );
  assert.equal(stopped.status, 124);
  assert.deepEqual(slots(dir), []);
  const next = await agentry(["run", "--limit", "5s", "--lock", "editor", "--", ...js("")], {
    cwd: dir,
  });
  assert.equal(next.status, 0);
  assert.equal(next.stderr, "", "taken at once");
});

// A holder session for the CLI's env: `CLAUDE_PID` names a live process.
const asSession = (pid) => ({ ...baseEnv(), CLAUDE_PID: String(pid) });
const groupAlive = (pgid) => alive(-pgid);

test("kill -9 of agentry run leaves its slot held while the command's group runs, and frees it once the group is gone", async (t) => {
  const dir = repo({ editor: 1 });
  const pidFile = join(dir, "cmd.pid");
  const first = agentry(
    [
      "run",
      "--limit",
      "60s",
      "--lock",
      "editor",
      "--",
      ...js(
        `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
      ),
    ],
    { cwd: dir, quiet: true },
  );
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
  const orphan = Number(readFileSync(pidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(-orphan, "SIGKILL");
    } catch {
      // gone already
    }
  });
  first.child.kill("SIGKILL");
  await first;
  const show = await agentry(["lock", "show"], { cwd: dir });
  assert.match(show.stdout, new RegExp(`^editor 1/1\\n.*orphan: pgid ${orphan} still running\\n$`));
  const busy = await agentry(
    ["run", "--limit", "5s", "--lock", "editor", "--wait", "1s", "--", ...js("")],
    { cwd: dir },
  );
  assert.equal(busy.status, 75, "a live group keeps the slot");
  process.kill(-orphan, "SIGKILL");
  await until(() => !groupAlive(orphan));
  const next = await agentry(["run", "--limit", "5s", "--lock", "editor", "--", ...js("")], {
    cwd: dir,
  });
  assert.equal(next.status, 0);
  assert.equal(next.stderr, "", "the orphan's slot was taken over at once");
  assert.match((await agentry(["lock", "show"], { cwd: dir })).stdout, /^editor 0\/1: free\n$/);
});

test("a run inside its own take uses that take: no wait, no second slot, the take stays", async () => {
  const dir = repo({ editor: 2 });
  const env = asSession(process.pid);
  assert.equal((await agentry(["lock", "take", "editor"], { cwd: dir, env })).status, 0);
  const started = join(dir, "started");
  const inside = agentry(
    [
      "run",
      "--limit",
      "20s",
      "--lock",
      "editor",
      "--wait",
      "1s",
      "--",
      ...js(`require('fs').writeFileSync(${JSON.stringify(started)},'');setTimeout(()=>{},1200)`),
    ],
    { cwd: dir, env },
  );
  await until(() => existsSync(started));
  assert.deepEqual(slots(dir), ["slot-1.lock"], "one slot while the run is inside the take");
  assert.match((await agentry(["lock", "show"], { cwd: dir })).stdout, /^editor 1\/2\n/);
  const run = await inside;
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "lock editor: inside your own take\n");
  assert.deepEqual(slots(dir), ["slot-1.lock"], "the run does not release the take");
});

test("a run by another session or another lane than the take still waits for it", async () => {
  const dir = repo({ editor: 1 });
  assert.equal(
    (await agentry(["lock", "take", "editor"], { cwd: dir, env: asSession(process.pid) })).status,
    0,
  );
  const other = await agentry(
    ["run", "--limit", "5s", "--lock", "editor", "--wait", "1s", "--", ...js("")],
    { cwd: dir, env: asSession(process.ppid) },
  );
  assert.equal(other.status, 75, "another session");
  const wt = join(dir, ".agentry", "run", "worktrees", "T-1");
  git(dir, "worktree", "add", "-q", "-b", "agentry/T-1", wt);
  const lane = await agentry(
    ["run", "--limit", "5s", "--lock", "editor", "--wait", "1s", "--", ...js("")],
    { cwd: wt, env: asSession(process.pid) },
  );
  assert.equal(lane.status, 75, "another lane of the same session");
});

test("a lane's worktree shares the main checkout's locks, named by its lane", async () => {
  const dir = repo({ editor: 1 });
  const wt = join(dir, ".agentry", "run", "worktrees", "T-1");
  git(dir, "worktree", "add", "-q", "-b", "agentry/T-1", wt);
  const started = join(dir, "started");
  const held = agentry(
    [
      "run",
      "--limit",
      "20s",
      "--lock",
      "editor",
      "--",
      ...js(`require('fs').writeFileSync(${JSON.stringify(started)},'');setTimeout(()=>{},1500)`),
    ],
    { cwd: wt },
  );
  await until(() => existsSync(started));
  const show = await agentry(["lock", "show"], { cwd: dir });
  assert.match(show.stdout, /^editor 1\/1\n {2}slot 1: T-1: node since \d\d:\d\d \(pid \d+\)\n$/);
  assert.equal((await held).status, 0);
});

test("--lock gives up after --wait: exit 75 naming the holder, and the command never runs", async () => {
  const dir = repo({ editor: 1 });
  const started = join(dir, "started");
  const holder = agentry(
    [
      "run",
      "--limit",
      "20s",
      "--lock",
      "editor",
      "--",
      ...js(`require('fs').writeFileSync(${JSON.stringify(started)},'');setTimeout(()=>{},3000)`),
    ],
    { cwd: dir },
  );
  await until(() => existsSync(started));
  const marker = join(dir, "ran");
  const run = await agentry(
    [
      "run",
      "--limit",
      "5s",
      "--lock",
      "editor",
      "--wait",
      "1s",
      "--",
      ...js(`require('fs').writeFileSync(${JSON.stringify(marker)},'')`),
    ],
    { cwd: dir },
  );
  assert.equal(run.status, 75);
  assert.match(
    run.stderr,
    /^waiting for lock editor \(held by node since \d\d:\d\d\)\n✗ run: lock editor busy \(held by node since \d\d:\d\d\) → agentry lock show\n$/,
  );
  assert.ok(run.ms >= 950 && run.ms < 5000, `${run.ms} ms`);
  assert.equal(existsSync(marker), false);
  assert.equal((await holder).status, 0);
});

test("--wait without --lock, and a --wait that is not a time, are refused", async () => {
  const dir = repo({ editor: 1 });
  for (const args of [
    ["--limit", "5s", "--wait", "1s", "--", ...js("")],
    ["--limit", "5s", "--lock", "editor", "--wait", "0s", "--", ...js("")],
  ]) {
    const run = await agentry(["run", ...args], { cwd: dir });
    assert.equal(run.status, 2, args.join(" "));
    assert.match(run.stderr, /^✗ agentry run: .*--wait/);
  }
});

test("--wait defaults to 10m, in both help texts", async () => {
  const dir = repo();
  assert.match((await agentry(["run", "--help"], { cwd: dir })).stdout, /--wait.*\(default 10m\)/);
  assert.match((await agentry(["lock", "--help"], { cwd: dir })).stdout, /--wait.*\(default 10m\)/);
});

test("the briefs' time-limit rule names --wait, the gate line names the gate slot, and lanes.md names agentry run", () => {
  const refs = join(PLUGIN, "skills", "conducting", "references");
  for (const brief of ["build", "verify"]) {
    const text = readFileSync(join(refs, "briefs", `${brief}.md`), "utf8");
    assert.match(text, /agentry run --limit <dur> -- …`[^\n]*--wait <dur>/, brief);
    assert.match(
      text,
      /Run the gate only as `agentry lane exec gate <id>` \(it takes the gate slot\); never run the gate script yourself/,
      brief,
    );
  }
  assert.match(readFileSync(join(refs, "lanes.md"), "utf8"), /`agentry run --limit <dur> -- …`/);
});

const gateSlots = (dir) => {
  const at = join(dir, ".agentry", "run", "gate-locks");
  return existsSync(at) ? readdirSync(at) : [];
};

test("a run of a gate tier's argv takes the gate slot for its life and says so", async () => {
  const dir = repo();
  const seen = join(dir, "seen");
  const tier = js(
    `const fs=require('fs');fs.writeFileSync(${JSON.stringify(seen)},fs.readdirSync(${JSON.stringify(join(dir, ".agentry", "run", "gate-locks"))}).join())`,
  );
  writeFileSync(
    join(dir, ".agentry", "workflow.json"),
    JSON.stringify({ gate: { tiers: [{ name: "full", command: tier }] } }),
  );
  const run = await agentry(["run", "--limit", "10s", "--", ...tier], { cwd: dir });
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "run: this is the gate (full): taking the gate slot\n");
  assert.equal(readFileSync(seen, "utf8"), "slot-1.lock", "held while the command ran");
  assert.deepEqual(gateSlots(dir), [], "released at the end");
});

test("two runs of the gate argv never overlap under gate.concurrency 1; other argv takes no slot", async () => {
  const dir = repo();
  const span = (name) => {
    const code = `const fs=require('fs'),f=${JSON.stringify(join(dir, name))};
      fs.writeFileSync(f,Date.now()+' ');setTimeout(()=>fs.appendFileSync(f,String(Date.now())),700)`;
    return js(code);
  };
  const [a, b] = [span("a"), span("b")];
  writeFileSync(
    join(dir, ".agentry", "workflow.json"),
    JSON.stringify({
      gate: {
        tiers: [
          { name: "quick", command: a, when: { any: ["x"] } },
          { name: "full", command: b },
        ],
        concurrency: 1,
      },
    }),
  );
  const runs = await Promise.all(
    [a, b].map((argv) => agentry(["run", "--limit", "20s", "--", ...argv], { cwd: dir })),
  );
  assert.deepEqual(
    runs.map((r) => r.status),
    [0, 0],
  );
  const [x, y] = ["a", "b"].map((n) => readFileSync(join(dir, n), "utf8").split(" ").map(Number));
  assert.ok(x[1] <= y[0] || y[1] <= x[0], `overlap: a ${x}, b ${y}`);
  const queued = runs.filter((r) => r.stderr.includes("waiting for gate slot"));
  assert.equal(queued.length, 1, "exactly one run waited");
  assert.match(
    queued[0].stderr,
    /\nwaiting for gate slot 1 \(held by agentry run since \d\d:\d\d\)\nslot acquired\n$/,
  );
  assert.match(runs[0].stderr, /^run: this is the gate \(quick\)/);
  assert.match(runs[1].stderr, /^run: this is the gate \(full\)/);
  const plain = await agentry(["run", "--limit", "5s", "--", ...js("")], { cwd: dir });
  assert.equal(plain.stderr, "", "an argv that is no tier's takes no gate slot");
});

test("the supervisor lives in lib/cli/supervise.mjs: run.mjs keeps the CLI and the locks", async () => {
  const cli = join(PLUGIN, "scripts", "lib", "cli");
  const run = await import(join(cli, "run.mjs"));
  assert.deepEqual(Object.keys(run).sort(), ["BUSY_EXIT", "durationMs", "lockCli", "runCli"]);
  const { supervise } = await import(join(cli, "supervise.mjs"));
  const started = [];
  const code = await supervise(js("process.exit(3)"), 10_000, "10s", {
    onStart: (pgid) => started.push(pgid),
  });
  assert.equal(code, 3);
  assert.equal(started.length, 1);
  assert.ok(Number.isInteger(started[0]) && started[0] > 1);
});

test("a command that exits but leaves a member of its group running keeps its slot as an orphan", async (t) => {
  const dir = repo({ editor: 1 });
  const pidFile = join(dir, "left.pid");
  const run = await agentry(
    [
      "run",
      "--limit",
      "20s",
      "--lock",
      "editor",
      "--",
      "sh",
      "-c",
      `sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}; exit 0`,
    ],
    { cwd: dir },
  );
  assert.equal(run.status, 0);
  const left = Number(readFileSync(pidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(left, "SIGKILL");
    } catch {
      // gone already
    }
  });
  const show = await agentry(["lock", "show"], { cwd: dir });
  const pgid = Number(/orphan: pgid (\d+) still running/.exec(show.stdout)?.[1]);
  assert.ok(pgid > 1, show.stdout);
  const busy = await agentry(
    ["run", "--limit", "5s", "--lock", "editor", "--wait", "1s", "--", ...js("")],
    { cwd: dir },
  );
  assert.equal(busy.status, 75, "the leftover keeps the slot");
  process.kill(left, "SIGKILL");
  await until(() => !groupAlive(pgid));
  const next = await agentry(["run", "--limit", "5s", "--lock", "editor", "--", ...js("")], {
    cwd: dir,
  });
  assert.equal(next.status, 0);
  assert.equal(next.stderr, "", "taken at once once the group is gone");
});

test("kill -9 of a gate run leaves the gate slot held while the gate's group runs", async (t) => {
  const dir = repo();
  const pidFile = join(dir, "gate.pid");
  const tier = js(
    `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
  );
  writeFileSync(
    join(dir, ".agentry", "workflow.json"),
    JSON.stringify({ gate: { tiers: [{ name: "full", command: tier }] } }),
  );
  const first = agentry(["run", "--limit", "60s", "--", ...tier], { cwd: dir, quiet: true });
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
  const orphan = Number(readFileSync(pidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(-orphan, "SIGKILL");
    } catch {
      // gone already
    }
  });
  first.child.kill("SIGKILL");
  await first;
  assert.ok(holdGate(gateLockDir(dir), { waitSec: 0 }).busy, "the gate's group still runs");
  process.kill(-orphan, "SIGKILL");
  await until(() => !groupAlive(orphan));
  holdGate(gateLockDir(dir), { waitSec: 0 }).release();
});

test("a run riding a take keeps the take until the run's limit, so no one runs beside it", async () => {
  const dir = repo({ editor: 1 });
  const env = asSession(process.pid);
  assert.equal(
    (await agentry(["lock", "take", "editor", "--ttl", "1s"], { cwd: dir, env })).status,
    0,
  );
  const started = join(dir, "started");
  const inside = agentry(
    [
      "run",
      "--limit",
      "20s",
      "--lock",
      "editor",
      "--",
      ...js(`require('fs').writeFileSync(${JSON.stringify(started)},'');setTimeout(()=>{},3000)`),
    ],
    { cwd: dir, env },
  );
  await until(() => existsSync(started));
  await new Promise((r) => setTimeout(r, 1500));
  const other = await agentry(
    ["run", "--limit", "5s", "--lock", "editor", "--wait", "1s", "--", ...js("")],
    { cwd: dir, env: asSession(process.ppid) },
  );
  assert.equal(other.status, 75, "the take outlived its ttl for the ridden run");
  assert.equal((await inside).status, 0);
});

test("a take and a run with no session pid and the same lane are one identity", async () => {
  const dir = repo({ editor: 1 });
  assert.equal((await agentry(["lock", "take", "editor"], { cwd: dir })).status, 0);
  const run = await agentry(
    ["run", "--limit", "5s", "--lock", "editor", "--wait", "1s", "--", ...js("")],
    { cwd: dir },
  );
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "lock editor: inside your own take\n");
});

test("a gate run takes the gate slot before its --lock, so the lock is not held while it queues", async () => {
  const dir = repo({ editor: 1 });
  const tier = js("0");
  writeFileSync(
    join(dir, ".agentry", "workflow.json"),
    JSON.stringify({ locks: { editor: 1 }, gate: { tiers: [{ name: "full", command: tier }] } }),
  );
  const other = holdGate(gateLockDir(dir), { who: "someone" });
  const run = agentry(["run", "--limit", "10s", "--lock", "editor", "--", ...tier], { cwd: dir });
  await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual(slots(dir), [], "the lock is not taken while the gate slot is busy");
  other.release();
  assert.equal((await run).status, 0);
});

const lockFile = (dir) => join(dir, ".agentry", "run", "locks", "editor", "slot-1.lock");
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// A run of `sleep`-like code that writes `started` and lives `ms` more, riding session `env`'s take.
function ride(dir, env, ms) {
  const started = join(dir, "started");
  const run = agentry(
    [
      "run",
      "--limit",
      "20s",
      "--lock",
      "editor",
      "--",
      ...js(`require('fs').writeFileSync(${JSON.stringify(started)},'');setTimeout(()=>{},${ms})`),
    ],
    { cwd: dir, env },
  );
  return { run, started: () => until(() => existsSync(started)) };
}

test("lock drop on a take a live run rides keeps the slot until the ride ends; no second driver starts beside it", async () => {
  const dir = repo({ editor: 1 });
  const env = asSession(process.pid);
  assert.equal((await agentry(["lock", "take", "editor"], { cwd: dir, env })).status, 0);
  const riding = ride(dir, env, 2500);
  await riding.started();
  const drop = await agentry(["lock", "drop", "editor"], { cwd: dir, env });
  assert.equal(drop.status, 0);
  assert.match(drop.stdout, /^lock editor: kept while your run \(pid \d+\) rides it\n$/);
  const other = await agentry(
    ["run", "--limit", "5s", "--lock", "editor", "--wait", "1s", "--", ...js("")],
    { cwd: dir, env: asSession(process.ppid) },
  );
  assert.equal(other.status, 75, "the dropped take still holds the slot for the ride");
  assert.equal((await riding.run).status, 0);
  assert.deepEqual(slots(dir), [], "the slot went with the ride");
});

test("lock drop with no ride drops at once", async () => {
  const dir = repo({ editor: 1 });
  const env = asSession(process.pid);
  assert.equal((await agentry(["lock", "take", "editor"], { cwd: dir, env })).status, 0);
  const drop = await agentry(["lock", "drop", "editor"], { cwd: dir, env });
  assert.equal(drop.stdout, "lock editor dropped\n");
  assert.deepEqual(slots(dir), []);
});

test("a ridden run's extension ends with the run: the take is back at its own until", async () => {
  const dir = repo({ editor: 1 });
  const env = asSession(process.pid);
  assert.equal(
    (await agentry(["lock", "take", "editor", "--ttl", "10s"], { cwd: dir, env })).status,
    0,
  );
  const own = JSON.parse(readFileSync(lockFile(dir), "utf8")).until;
  const riding = ride(dir, env, 1500);
  await riding.started();
  const extended = Date.parse(JSON.parse(readFileSync(lockFile(dir), "utf8")).until);
  assert.ok(extended > Date.parse(own) + 5000, "extended past the ttl while it rides");
  assert.equal((await riding.run).status, 0);
  assert.equal(JSON.parse(readFileSync(lockFile(dir), "utf8")).until, own);
});

test("--wait is accepted with a gate argv and bounds the gate slot wait; both helps say so", async () => {
  const dir = repo();
  const tier = js("0");
  writeFileSync(
    join(dir, ".agentry", "workflow.json"),
    JSON.stringify({ gate: { tiers: [{ name: "full", command: tier }] } }),
  );
  const other = holdGate(gateLockDir(dir), { who: "someone" });
  const run = await agentry(["run", "--limit", "10s", "--wait", "1s", "--", ...tier], { cwd: dir });
  other.release();
  assert.equal(run.status, 75);
  assert.match(run.stderr, /the gate slot stayed busy/);
  assert.ok(run.ms < 5000, `gave up after the wait (${run.ms} ms)`);
  assert.match((await agentry(["run", "--help"], { cwd: dir })).stdout, /--wait[^\n]*gate/);
});

test("a gate argv with --lock never holds the gate slot while the lock is busy, then queues for the gate again", async () => {
  const dir = repo({ editor: 1 });
  const tier = js("0");
  writeFileSync(
    join(dir, ".agentry", "workflow.json"),
    JSON.stringify({ locks: { editor: 1 }, gate: { tiers: [{ name: "full", command: tier }] } }),
  );
  const env = asSession(process.pid);
  assert.equal(
    (await agentry(["lock", "take", "editor", "--for", "other", "--ttl", "2s"], { cwd: dir, env }))
      .status,
    0,
  );
  const run = agentry(
    ["run", "--limit", "10s", "--lock", "editor", "--wait", "8s", "--", ...tier],
    {
      cwd: dir,
    },
  );
  await sleepMs(900);
  assert.deepEqual(gateSlots(dir), [], "the gate slot is free while the lock is awaited");
  const result = await run;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /gate slot released while waiting/);
  assert.deepEqual(gateSlots(dir), []);
  assert.deepEqual(slots(dir), []);
});

test("lock drop --orphan frees a slot only a leftover group holds, printing the pgid; refused while the run lives", async (t) => {
  const dir = repo({ editor: 1 });
  const pidFile = join(dir, "cmd.pid");
  const first = agentry(
    [
      "run",
      "--limit",
      "60s",
      "--lock",
      "editor",
      "--",
      ...js(
        `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
      ),
    ],
    { cwd: dir, quiet: true },
  );
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
  const orphan = Number(readFileSync(pidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(-orphan, "SIGKILL");
    } catch {
      // gone already
    }
  });
  const live = await agentry(["lock", "drop", "editor", "--orphan"], { cwd: dir });
  assert.equal(live.status, 1, "the recording run still lives");
  assert.match(live.stdout, /still lives/);
  first.child.kill("SIGKILL");
  await first;
  const freed = await agentry(["lock", "drop", "editor", "--orphan"], { cwd: dir });
  assert.equal(freed.status, 0, freed.stdout);
  assert.match(freed.stdout, new RegExp(`pgid ${orphan}`));
  assert.deepEqual(slots(dir), []);
  assert.equal((await agentry(["lock", "drop", "editor", "--orphan"], { cwd: dir })).status, 1);
});

test("kill -9 of a ridden run keeps the take while its command's group runs, so no second session starts beside it", async (t) => {
  const dir = repo({ editor: 1 });
  const env = asSession(process.pid);
  assert.equal(
    (await agentry(["lock", "take", "editor", "--ttl", "2s"], { cwd: dir, env })).status,
    0,
  );
  const pidFile = join(dir, "cmd.pid");
  const riding = agentry(
    [
      "run",
      "--limit",
      "60s",
      "--lock",
      "editor",
      "--",
      ...js(
        `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
      ),
    ],
    { cwd: dir, env, quiet: true },
  );
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
  const command = Number(readFileSync(pidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(-command, "SIGKILL");
    } catch {
      // gone already
    }
  });
  await sleepMs(200);
  riding.child.kill("SIGKILL");
  await riding;
  await sleepMs(2200);
  assert.ok(alive(command), "the command outlived its run");
  const other = () =>
    agentry(["run", "--limit", "5s", "--lock", "editor", "--wait", "1s", "--", ...js("")], {
      cwd: dir,
      env: asSession(process.ppid),
    });
  assert.equal((await other()).status, 75, "the take holds while the ridden command runs");
  process.kill(-command, "SIGKILL");
  await until(() => !alive(command));
  assert.equal((await other()).status, 0, "the take is back at its own until, long passed");
});

test("a gate argv whose own take ended while it queued for the gate does not ride another session's take", async () => {
  const dir = repo({ editor: 1 });
  const tier = js("0");
  writeFileSync(
    join(dir, ".agentry", "workflow.json"),
    JSON.stringify({ locks: { editor: 1 }, gate: { tiers: [{ name: "full", command: tier }] } }),
  );
  const env = asSession(process.pid);
  const gate = holdGate(gateLockDir(dir), { who: "someone" });
  assert.equal(
    (await agentry(["lock", "take", "editor", "--ttl", "1s"], { cwd: dir, env })).status,
    0,
  );
  const run = agentry(
    ["run", "--limit", "10s", "--lock", "editor", "--wait", "4s", "--", ...tier],
    { cwd: dir, env },
  );
  await sleepMs(1300);
  const other = await agentry(["lock", "take", "editor", "--for", "other", "--ttl", "1m"], {
    cwd: dir,
    env: asSession(process.ppid),
  });
  assert.equal(other.status, 0, other.stderr);
  gate.release();
  const result = await run;
  assert.doesNotMatch(result.stderr, /inside your own take/);
  assert.equal(result.status, 75, "it waits for the other session's take instead");
  const holder = JSON.parse(readFileSync(lockFile(dir), "utf8"));
  assert.equal(holder.who, "other");
  assert.equal(holder.riders, undefined, "no rider written into another session's take");
});

// A ride of session `env`'s take whose command writes `<name>.pid` (its pid) and then lives `ms`, or until
// it is killed when `ms` is null.
function rideNamed(dir, env, name, ms) {
  const pidFile = join(dir, `${name}.pid`);
  const live = ms === null ? "setInterval(()=>{},1000)" : `setTimeout(()=>{},${ms})`;
  const run = agentry(
    [
      "run",
      "--limit",
      "20s",
      "--lock",
      "editor",
      "--",
      ...js(`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));${live}`),
    ],
    { cwd: dir, env },
  );
  const command = () => Number(readFileSync(pidFile, "utf8"));
  const started = () => until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
  return { run, command, started };
}
const ROUNDS = 5;

test("two rides of one take that start together are both recorded as riders", async () => {
  const dir = repo({ editor: 1 });
  const env = asSession(process.pid);
  for (let round = 1; round <= ROUNDS; round++) {
    assert.equal((await agentry(["lock", "take", "editor"], { cwd: dir, env })).status, 0);
    const one = rideNamed(dir, env, `a${round}`, 1200);
    const two = rideNamed(dir, env, `b${round}`, 1200);
    await Promise.all([one.started(), two.started()]);
    const riders = JSON.parse(readFileSync(lockFile(dir), "utf8")).riders.map((r) => r.pid);
    assert.deepEqual(
      riders.sort(),
      [one.run.child.pid, two.run.child.pid].sort(),
      `round ${round}: both runs ride`,
    );
    await Promise.all([one.run, two.run]);
    assert.equal((await agentry(["lock", "drop", "editor"], { cwd: dir, env })).status, 0);
  }
});

test("two rides that start together, one ending first after a kept drop: no second session starts beside the other", async (t) => {
  const dir = repo({ editor: 1 });
  const env = asSession(process.pid);
  for (let round = 1; round <= ROUNDS; round++) {
    assert.equal((await agentry(["lock", "take", "editor"], { cwd: dir, env })).status, 0);
    const short = rideNamed(dir, env, `s${round}`, 300);
    const long = rideNamed(dir, env, `l${round}`, null);
    await Promise.all([short.started(), long.started()]);
    t.after(() => {
      try {
        process.kill(-long.command(), "SIGKILL");
      } catch {
        // gone already
      }
    });
    assert.equal((await agentry(["lock", "drop", "editor"], { cwd: dir, env })).status, 0);
    await short.run;
    const other = await agentry(
      ["run", "--limit", "5s", "--lock", "editor", "--wait", "1s", "--", ...js("")],
      { cwd: dir, env: asSession(process.ppid) },
    );
    assert.ok(alive(long.command()), "the long ride still runs");
    assert.equal(other.status, 75, `round ${round}: kept out while the long ride runs`);
    long.run.child.kill("SIGTERM");
    await long.run;
    assert.deepEqual(slots(dir), [], `round ${round}: the slot went with the last ride`);
  }
});

test("kill -9 of a ridden run holds the take past the run's limit while its command lives, and frees it after", async (t) => {
  const dir = repo({ editor: 1 });
  const env = asSession(process.pid);
  assert.equal(
    (await agentry(["lock", "take", "editor", "--ttl", "2s"], { cwd: dir, env })).status,
    0,
  );
  const pidFile = join(dir, "cmd.pid");
  const riding = agentry(
    [
      "run",
      "--limit",
      "3s",
      "--lock",
      "editor",
      "--",
      ...js(
        `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
      ),
    ],
    { cwd: dir, env, quiet: true },
  );
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
  const command = Number(readFileSync(pidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(-command, "SIGKILL");
    } catch {
      // gone already
    }
  });
  await sleepMs(200);
  riding.child.kill("SIGKILL");
  await riding;
  await sleepMs(8500);
  assert.ok(alive(command), "the command outlived its run's limit and grace");
  const other = () =>
    agentry(["run", "--limit", "5s", "--lock", "editor", "--wait", "1s", "--", ...js("")], {
      cwd: dir,
      env: asSession(process.ppid),
    });
  assert.equal((await other()).status, 75, "held while the ridden command lives");
  process.kill(-command, "SIGKILL");
  await until(() => !alive(command));
  assert.equal((await other()).status, 0, "free once it is gone");
});
