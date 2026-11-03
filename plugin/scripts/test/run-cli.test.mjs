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

test("kill -9 of agentry run frees its lock: the next taker finds its pid gone", async (t) => {
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
  const next = await agentry(["run", "--limit", "5s", "--lock", "editor", "--", ...js("")], {
    cwd: dir,
  });
  assert.equal(next.status, 0);
  assert.equal(next.stderr, "", "the dead holder's slot was taken over at once");
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
