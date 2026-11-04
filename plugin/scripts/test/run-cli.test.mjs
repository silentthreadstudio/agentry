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
