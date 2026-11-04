// Tests for `lane sweep` (lib/lane/sweep.mjs, cli/sweep.mjs): merged tasks' worktrees go, unknown ones and
// live tasks' stay, a process under `.agentry/run/` is stopped only with --apply, and low disk warns.
// Run: node --test plugin/scripts/test/sweep.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gateLockDir, holdGate } from "../lib/lane/gate-lock.mjs";
import { lockDir, setGroup, tryLock } from "../lib/lane/named-lock.mjs";
import { LOW_DISK, plan } from "../lib/lane/sweep.mjs";
import { identity } from "../lib/process/pid.mjs";
import { boardRepo, builtBranch, handBranch, ledger } from "./drift-repo.mjs";
import { git, gitEnv } from "./git-repo.mjs";
import { writeSpec } from "./spec-files.mjs";

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");
const cleanups = [];
const children = [];
// Pids a test planted other than through `children` (a group a dead run left, its command's group).
const planted = [];
// `{ pid, ppid, pgid, zombie }` of every process now.
const snapshot = () =>
  spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat="], { encoding: "utf8" })
    .stdout.split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length === 4)
    .map(([pid, ppid, pgid, stat]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      zombie: stat.startsWith("Z"),
    }));
// `tops`, everything below them by parent, and every member of a group one of them leads.
function treesOf(tops) {
  const procs = snapshot();
  const found = new Set(tops);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs)
      if (!found.has(p.pid) && (found.has(p.ppid) || (tops.includes(p.pgid) && p.pgid > 1))) {
        found.add(p.pid);
        grew = true;
      }
  }
  return found;
}
const living = (pids) =>
  snapshot()
    .filter((p) => pids.has(p.pid) && !p.zombie)
    .map((p) => p.pid);
after(async () => {
  // Each planted process goes with its whole tree and group, found before any of it is killed (a killed
  // parent's children are re-parented and could no longer be found by it).
  const doomed = treesOf([...children.map((c) => c.pid), ...planted].filter(Number.isInteger));
  for (const pid of doomed)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone already
    }
  for (const c of cleanups) c();
  for (const end = Date.now() + 3000; living(doomed).length && Date.now() < end; )
    await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(living(doomed), [], "a process this file started still runs");
});

/** A repo with a merged task (T1), a task still building (T2) and a worktree no ledger knows. */
function fixture() {
  const repo = boardRepo();
  cleanups.push(repo.cleanup);
  const { root } = repo;
  const merged = builtBranch(root, "T1");
  git(root, "cherry-pick", merged.sha);
  ledger(root, "T1", { state: "merged", worktree: merged.path });
  const live = builtBranch(root, "T2");
  ledger(root, "T2", { worktree: live.path });
  const stranger = join(root, ".agentry", "run", "worktrees", "X9");
  git(root, "worktree", "add", "-q", "-b", "agentry/X9", stranger, "main");
  return { root, merged, live, stranger };
}

const sweep = (root, ...args) =>
  spawnSync("node", [LANE, "sweep", ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, NO_COLOR: "1" },
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async (pid) => {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
};
const settle = () => new Promise((r) => setTimeout(r, 400));
/** A long-lived node process running a script written at `file`, in `cwd`; `args` follow the script. */
function plant(file, { cwd = tmpdir(), args = [] } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "setTimeout(() => {}, 300000)");
  const child = spawn("node", [file, ...args], { stdio: "ignore", cwd });
  children.push(child);
  return child;
}
const runFile = (root, name) => join(root, ".agentry", "run", name);

test("a dry run reports merged worktrees, unknown ones and strays, and changes nothing", async () => {
  const { root, merged, stranger } = fixture();
  const stray = plant(runFile(root, "marker-dry.js"));
  await settle();
  const res = sweep(root);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /would remove worktree T1/);
  assert.match(res.stdout, new RegExp(`unknown worktree ${stranger}`));
  assert.match(res.stdout, new RegExp(`would stop process ${stray.pid}`));
  assert.ok(existsSync(merged.path));
  assert.ok(alive(stray.pid));
});

test("--json says whether it applied: false on the preview, true with --apply", () => {
  const { root } = fixture();
  const dry = JSON.parse(sweep(root, "--json").stdout);
  assert.equal(dry.applied, false);
  assert.equal(dry.result, null);
  assert.equal(JSON.parse(sweep(root, "--apply", "--json").stdout).applied, true);
});

test("--apply removes only the merged task's worktree, and leaves live and unknown ones", () => {
  const { root, merged, live, stranger } = fixture();
  const res = sweep(root, "--apply", "--json");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).result.removed[0].id, "T1");
  assert.ok(!existsSync(merged.path));
  assert.equal(git(root, "branch", "--list", "agentry/T1"), "");
  assert.ok(existsSync(live.path));
  assert.ok(existsSync(stranger));
});

test("--apply stops a process running a script under .agentry/run/ and leaves one outside it", async () => {
  const { root } = fixture();
  const inside = plant(runFile(root, "marker-kill.js"));
  const outside = plant(join(root, "elsewhere", "marker-keep.js"));
  await settle();
  const res = sweep(root, "--apply");
  assert.equal(res.status, 0, res.stderr);
  assert.ok(await waitDead(inside.pid), "the process under .agentry/run/ should be stopped");
  assert.ok(alive(outside.pid), "a process outside it must be left alone");
});

test("a process whose working directory is under .agentry/run/ is a stray", async () => {
  const { root } = fixture();
  mkdirSync(runFile(root, "scratch"), { recursive: true });
  const inside = plant(join(root, "elsewhere", "cwd.js"), { cwd: runFile(root, "scratch") });
  await settle();
  assert.equal(sweep(root, "--apply").status, 0);
  assert.ok(await waitDead(inside.pid));
});

test("a path that only contains the run directory as a substring is not a stray", async () => {
  const { root } = fixture();
  const nested = mkdtempSync(join(tmpdir(), "sweep-nest-"));
  cleanups.push(() => rmSync(nested, { recursive: true, force: true }));
  const lookalike = plant(join(nested, `nest${runFile(root, "z.js")}`));
  await settle();
  assert.equal(sweep(root, "--apply").status, 0);
  assert.ok(alive(lookalike.pid), "a look-alike path must not match");
});

test("a process that only names a run path as an argument is left alone", async () => {
  const { root } = fixture();
  const watcher = plant(join(root, "elsewhere", "tail.js"), {
    args: [runFile(root, "process/runs/T1/gate.log")],
  });
  await settle();
  assert.equal(sweep(root, "--apply").status, 0);
  assert.ok(alive(watcher.pid), "an argv mention is not a stray");
});

test("a process of a lane still building is left alone; one of a merged lane is stopped", async () => {
  const { root, merged, live } = fixture();
  const building = plant(join(root, "elsewhere", "live.js"), { cwd: live.path });
  const finished = plant(join(root, "elsewhere", "done.js"), { cwd: merged.path });
  await settle();
  const dry = sweep(root).stdout;
  assert.match(dry, new RegExp(`would stop process ${finished.pid}`));
  assert.doesNotMatch(dry, new RegExp(`process ${building.pid}`));
  sweep(root, "--apply");
  assert.ok(await waitDead(finished.pid));
  assert.ok(alive(building.pid), "the building lane's process must survive");
});

test("--apply takes the stray's whole process group down, children included", async () => {
  const { root } = fixture();
  const script = runFile(root, "group.sh");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "sleep 300 &\nwait\n");
  const leader = spawn("sh", [script], { stdio: "ignore", detached: true });
  children.push(leader);
  await settle();
  const pgrep = spawnSync("pgrep", ["-P", String(leader.pid)], { encoding: "utf8" });
  const kid = Number(pgrep.stdout.trim());
  assert.ok(kid > 0, "the shell should have a sleeping child");
  const res = sweep(root, "--apply", "--json");
  assert.equal(res.status, 0, res.stdout);
  assert.deepEqual(JSON.parse(res.stdout).result.survived, []);
  assert.ok(await waitDead(kid), "the child must not be orphaned and left running");
  assert.ok(await waitDead(leader.pid));
});

test("a merged worktree holding an ignored file is kept unless --discard-ignored", () => {
  const { root, merged } = fixture();
  appendFileSync(join(root, ".git", "info", "exclude"), ".env\n");
  writeFileSync(join(merged.path, ".env"), "SECRET=1\n");
  const dry = sweep(root);
  assert.match(dry.stdout, /would keep worktree T1: holds 1 ignored file\(s\).*\.env/);
  const kept = sweep(root, "--apply");
  assert.equal(kept.status, 1);
  assert.match(kept.stdout, /kept worktree T1.*ignored/);
  assert.equal(readFileSync(join(merged.path, ".env"), "utf8"), "SECRET=1\n");
  const gone = sweep(root, "--apply", "--discard-ignored");
  assert.equal(gone.status, 0, gone.stdout);
  assert.ok(!existsSync(merged.path));
});

test("a merged worktree holding only node_modules and dist output is swept, and the line says so", () => {
  const { root, merged } = fixture();
  appendFileSync(join(root, ".git", "info", "exclude"), "node_modules/\ndist/\n");
  mkdirSync(join(merged.path, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(merged.path, "node_modules", "pkg", "index.js"), "x");
  mkdirSync(join(merged.path, "dist"));
  writeFileSync(join(merged.path, "dist", "out.js"), "x");
  const dry = sweep(root);
  assert.match(dry.stdout, /would remove worktree T1 \(would discard 2 disposable path\(s\)\)/);
  const res = sweep(root, "--apply");
  assert.equal(res.status, 0, res.stdout);
  assert.match(res.stdout, /removed worktree T1 \(discarded 2 disposable path\(s\)\)/);
  assert.ok(!existsSync(merged.path));
});

test("a node_modules folder of 300 files counts as one disposable path", () => {
  const { root, merged } = fixture();
  appendFileSync(join(root, ".git", "info", "exclude"), "node_modules/\n");
  mkdirSync(join(merged.path, "node_modules", "pkg"), { recursive: true });
  for (let i = 0; i < 300; i++)
    writeFileSync(join(merged.path, "node_modules", "pkg", `f${i}.js`), "x");
  const dry = sweep(root);
  assert.match(dry.stdout, /would remove worktree T1 \(would discard 1 disposable path\(s\)\)/);
  const res = sweep(root, "--apply");
  assert.equal(res.status, 0, res.stdout);
  assert.match(res.stdout, /removed worktree T1 \(discarded 1 disposable path\(s\)\)/);
});

// A bad cleanup.disposable (or a workflow file that is not JSON) never stops the sweep: the defaults still
// apply and one line says what was ignored.
const BAD_DISPOSABLE = ["5", '{"a":1}', "true", "[1,null]", '"x"', "null"];
for (const value of [...BAD_DISPOSABLE, undefined]) {
  test(`a workflow file with cleanup.disposable ${value ?? "that is not JSON"} is ignored by the sweep, not a crash`, () => {
    const { root, merged } = fixture();
    const file = join(root, ".agentry", "workflow.json");
    writeFileSync(
      file,
      value === undefined ? "{ not json" : `{ "cleanup": { "disposable": ${value} } }`,
    );
    appendFileSync(join(root, ".git", "info", "exclude"), "node_modules/\n");
    mkdirSync(join(merged.path, "node_modules"));
    writeFileSync(join(merged.path, "node_modules", "x.js"), "x");
    for (const args of [[], ["--apply"], ["--json"]]) {
      const res = sweep(root, ...args);
      assert.ok([0, 1].includes(res.status), `${args}: ${res.status}\n${res.stdout}${res.stderr}`);
      assert.doesNotMatch(res.stderr, /TypeError|at .*\.mjs:\d+/);
      if (!args.includes("--json"))
        assert.match(res.stdout, /! cleanup\.disposable ignored: .*\(.*workflow\.json\)/);
    }
    assert.ok(!existsSync(merged.path), "the default node_modules is still discarded");
  });
}

test("a good cleanup.disposable, or no process file at all, prints no ignored line", () => {
  const { root } = fixture();
  const res = sweep(root);
  assert.doesNotMatch(res.stdout, /cleanup\.disposable ignored/);
  rmSync(join(root, ".agentry", "process.json"));
  rmSync(join(root, ".agentry", "workflow.json"), { force: true });
  const bare = sweep(root);
  assert.equal(bare.status, 0, bare.stdout + bare.stderr);
  assert.doesNotMatch(bare.stdout, /cleanup\.disposable ignored/);
  assert.doesNotMatch(bare.stderr, /TypeError/);
});

test("cleanup.disposable from the workflow file adds to the defaults in the sweep", () => {
  const { root, merged } = fixture();
  const dir = join(root, ".agentry");
  const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  const spec = {
    ...read("process.json"),
    ...(existsSync(join(dir, "workflow.json")) ? read("workflow.json") : {}),
  };
  writeSpec(dir, { ...spec, cleanup: { disposable: ["cache/**"] } });
  appendFileSync(join(root, ".git", "info", "exclude"), "cache/\ndist/\n");
  for (const dir of ["cache", "dist"]) {
    mkdirSync(join(merged.path, dir));
    writeFileSync(join(merged.path, dir, "out"), "x");
  }
  const res = sweep(root, "--apply");
  assert.equal(res.status, 0, res.stdout);
  assert.match(res.stdout, /discarded 2 disposable path\(s\)/);
  assert.ok(!existsSync(merged.path));
});

test("a stray untracked file or any other ignored file keeps a worktree that also holds build output", () => {
  const { root, merged } = fixture();
  appendFileSync(join(root, ".git", "info", "exclude"), "node_modules/\n.env\n");
  mkdirSync(join(merged.path, "node_modules"));
  writeFileSync(join(merged.path, "node_modules", "x.js"), "x");
  writeFileSync(join(merged.path, "scratch.txt"), "mine\n");
  const stray = sweep(root, "--apply");
  assert.equal(stray.status, 1, stray.stdout);
  assert.match(stray.stdout, /kept worktree T1: .*uncommitted changes.*scratch\.txt/);
  assert.ok(existsSync(join(merged.path, "node_modules", "x.js")));
  rmSync(join(merged.path, "scratch.txt"));
  writeFileSync(join(merged.path, ".env"), "SECRET=1\n");
  const env = sweep(root, "--apply");
  assert.equal(env.status, 1, env.stdout);
  assert.match(env.stdout, /kept worktree T1: holds 1 ignored file\(s\).*\.env/);
  assert.ok(existsSync(join(merged.path, "node_modules", "x.js")));
});

test("a closed task's worktree is cleanable too", () => {
  const { root } = fixture();
  const done = builtBranch(root, "T4");
  git(root, "cherry-pick", done.sha);
  ledger(root, "T4", { state: "closed", worktree: done.path });
  assert.ok(plan(root).cleanable.some((w) => w.id === "T4"));
});

test("a merged task's dirty worktree is kept and reported", () => {
  const { root, merged } = fixture();
  mkdirSync(join(merged.path, "scratch"));
  spawnSync("touch", [join(merged.path, "scratch", "wip.txt")]);
  const res = sweep(root, "--apply");
  assert.equal(res.status, 1);
  assert.match(res.stdout, /kept worktree T1.*uncommitted/);
  assert.ok(existsSync(merged.path));
});

test("a worktree outside the lane's directory is never listed", () => {
  const repo = boardRepo();
  cleanups.push(repo.cleanup);
  handBranch(repo.root, "hand-tree", "feature/hand");
  const found = plan(repo.root);
  assert.deepEqual([found.cleanable, found.unknown], [[], []]);
});

test("less than 10 GB free is a warning; plenty is not", () => {
  const repo = boardRepo();
  cleanups.push(repo.cleanup);
  assert.match(plan(repo.root, { free: LOW_DISK - 1 }).warnings[0], /GB free/);
  assert.deepEqual(plan(repo.root, { free: LOW_DISK }).warnings, []);
});

// ---- fix round 2 (R1b-7 re-verify) ----

/** A shell script at `file` that `sh` runs as a plain (not detached) child of the test: no group of its own. */
function plantShell(file, body, { cwd = tmpdir() } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  const child = spawn("/bin/sh", [file], { stdio: "ignore", cwd });
  children.push(child);
  return child;
}
const childOf = (pid) =>
  Number(spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.trim());

test("a stray that does not lead its group is stopped with its whole descendant tree", async () => {
  const { root } = fixture();
  const stray = plantShell(runFile(root, "runs/T1/tree.sh"), "sleep 300\n");
  await settle();
  const kid = childOf(stray.pid);
  assert.ok(kid > 0, "the shell should have a sleeping child");
  const res = sweep(root, "--apply", "--json");
  assert.equal(res.status, 0, res.stdout);
  assert.deepEqual(JSON.parse(res.stdout).result.survived, []);
  assert.ok(await waitDead(stray.pid));
  assert.ok(await waitDead(kid), "the child must not be orphaned and left running");
});

test("an interactive shell in a merged worktree is never signalled", async () => {
  const { root, merged } = fixture();
  const stdio = ["pipe", "ignore", "ignore"];
  const login = spawn("/bin/zsh", ["-f"], { argv0: "-zsh", cwd: merged.path, stdio });
  const inter = spawn("/bin/zsh", ["-f", "-i"], { cwd: merged.path, stdio });
  const plain = plant(join(root, "elsewhere", "plain.js"), { cwd: merged.path });
  children.push(login, inter);
  await settle();
  const dry = sweep(root);
  assert.match(dry.stdout, new RegExp(`left alone: interactive shell.*${login.pid}`));
  assert.match(dry.stdout, new RegExp(`left alone: interactive shell.*${inter.pid}`));
  assert.match(dry.stdout, new RegExp(`would stop process ${plain.pid}`));
  const res = sweep(root, "--apply");
  assert.equal(res.status, 1, res.stdout); // the worktree the shells sit in is kept
  assert.ok(await waitDead(plain.pid), "an ordinary stray is still stopped");
  await settle();
  assert.ok(alive(login.pid), "the login shell must survive");
  assert.ok(alive(inter.pid), "the interactive shell must survive");
});

const python = spawnSync("python3", ["-c", "import pty"]).status === 0;
test(
  "a process on a terminal, cwd in a merged worktree, is never signalled",
  { skip: !python },
  async () => {
    const { root, merged } = fixture();
    const dir = mkdtempSync(join(tmpdir(), "sweep-tty-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const py = join(dir, "term.py");
    writeFileSync(
      py,
      `import os, pty, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.chdir(sys.argv[1])
    os.execv("/bin/sleep", ["sleep", "300"])
print(pid, flush=True)
time.sleep(300)
`,
    );
    const term = spawn("python3", ["-I", py, merged.path], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    children.push(term);
    const pid = await new Promise((r) => term.stdout.once("data", (d) => r(Number(String(d)))));
    await settle();
    const res = sweep(root, "--apply");
    assert.equal(res.status, 1, res.stdout); // the worktree the terminal sits in is kept
    assert.match(res.stdout, new RegExp(`left alone: interactive shell.*${pid}`));
    await settle();
    // Its parent (python) never reaps it, so a signalled one would linger as a zombie: read its state.
    const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout;
    assert.ok(
      stat.trim() && !stat.startsWith("Z"),
      "a process with a controlling terminal must survive",
    );
    process.kill(pid, "SIGKILL");
  },
);

test("a merged ledger that claims the repo root does not claim a live lane's processes", async () => {
  const { root, live } = fixture();
  ledger(root, "T0", { state: "merged", worktree: root });
  const building = plant(join(root, "elsewhere", "live9.js"), { cwd: live.path });
  await settle();
  assert.doesNotMatch(sweep(root).stdout, new RegExp(`process ${building.pid}`));
  const res = sweep(root, "--apply");
  assert.equal(res.status, 0, res.stdout);
  await settle(); // let the event loop reap the child, so a signalled one is not a zombie that looks alive
  assert.ok(alive(building.pid), "the building lane's process must survive");
});

test("an option's value is not taken for the script a node process runs", async () => {
  const { root } = fixture();
  const hook = join(root, "elsewhere", "hook.cjs");
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, "\n");
  const script = runFile(root, "runs/T1/x.mjs");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "setTimeout(() => {}, 300000)");
  const stray = spawn("node", ["--require", hook, script], { stdio: "ignore", cwd: tmpdir() });
  children.push(stray);
  await settle();
  assert.match(sweep(root).stdout, new RegExp(`would stop process ${stray.pid}`));
});

test("a missing lsof is a warning: strays by working directory can't be seen", () => {
  const { root } = fixture();
  const bin = mkdtempSync(join(tmpdir(), "sweep-bin-"));
  cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
  for (const tool of ["ps", "git"]) {
    const found = spawnSync("which", [tool], { encoding: "utf8" }).stdout.trim();
    symlinkSync(found, join(bin, tool));
  }
  const res = spawnSync(process.execPath, [LANE, "sweep", "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, NO_COLOR: "1", PATH: bin },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /warning: lsof not found/);
});

// ---- fix round 3 (R1b-7 re-verify) ----

/** `body` run by a login shell (`-sh`, so the owner's shell by name) in `cwd`, as a child of the test. */
function plantLogin(file, body, { cwd = tmpdir(), detached = false } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  const child = spawn("/bin/sh", [file], { argv0: "-sh", stdio: "ignore", cwd, detached });
  children.push(child);
  return child;
}
const runStray = (root, name) => {
  const file = runFile(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "setTimeout(() => {}, 300000)");
  return file;
};
const sleepsIn = (group) =>
  spawnSync("pgrep", ["-g", String(group), "-f", "sleep 300"], { encoding: "utf8" })
    .stdout.split("\n")
    .map(Number)
    .filter((pid) => pid > 0);

test("a stray under an interactive ancestor is stopped; the ancestor is not", async () => {
  const { root } = fixture();
  const script = runStray(root, "runs/T1/under-login.js");
  const login = plantLogin(join(root, "elsewhere", "login.sh"), `node ${script} &\nwait\n`);
  await settle();
  const stray = childOf(login.pid);
  assert.ok(stray > 0, "the login shell should have started the stray");
  const res = sweep(root, "--apply", "--json");
  assert.equal(res.status, 0, res.stdout);
  assert.ok(await waitDead(stray), "the stray must be stopped although a login shell is above it");
  assert.ok(alive(login.pid), "the login shell itself is never signalled");
});

test("a -i that follows the script is the script's argument, not a shell option", async () => {
  const { root } = fixture();
  const script = runFile(root, "runs/T1/args.sh");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "sleep 300\n");
  const stray = spawn("/bin/sh", [script, "-i"], { stdio: "ignore", cwd: tmpdir() });
  children.push(stray);
  await settle();
  assert.match(sweep(root).stdout, new RegExp(`would stop process ${stray.pid}`));
});

test("a descendant shell run -i with no terminal is stopped with its stray", async () => {
  const { root } = fixture();
  const stray = plantShell(
    runFile(root, "runs/T1/inter.sh"),
    // Two commands, so bash stays (one would be exec'd); the second is not another sleep, because an
    // interactive bash ignores SIGTERM and would start it after the first one dies.
    "/bin/bash -i -c 'sleep 300; exit'\n",
  );
  await settle();
  const shell = childOf(stray.pid);
  assert.ok(shell > 0, "the stray should have started the shell");
  const res = sweep(root, "--apply", "--json");
  assert.equal(res.status, 0, res.stdout);
  assert.ok(await waitDead(shell), "a no-terminal bash -i is not the owner's shell");
  assert.ok(await waitDead(stray.pid));
});

test("a double-forked child that stayed in the stray's group is stopped too", async () => {
  const { root } = fixture();
  const script = runFile(root, "runs/T1/fork.sh");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "( sleep 300 & )\nsleep 300\n");
  const leader = spawn("/bin/sh", [script], { stdio: "ignore", detached: true });
  children.push(leader);
  await settle();
  const kid = childOf(leader.pid);
  const orphan = sleepsIn(leader.pid).find((pid) => pid !== kid);
  assert.ok(orphan, "the group should hold a sleep that is not the stray's child");
  const res = sweep(root, "--apply", "--json");
  assert.equal(res.status, 0, res.stdout);
  assert.ok(await waitDead(orphan), "the orphan in the stray's group must go");
});

test("a group that holds an interactive shell is not taken down", async () => {
  const { root } = fixture();
  const script = runStray(root, "runs/T1/shared.js");
  const login = plantLogin(
    join(root, "elsewhere", "shared.sh"),
    `( sleep 300 & )\nnode ${script} &\nwhile :; do sleep 1; done\n`,
    { detached: true },
  );
  await settle();
  const [orphan] = sleepsIn(login.pid);
  assert.ok(orphan, "the group should hold an orphaned sleep");
  const res = sweep(root, "--apply", "--json");
  assert.equal(res.status, 0, res.stdout);
  await settle();
  assert.ok(alive(orphan), "a group with the owner's shell in it is left whole");
  assert.ok(alive(login.pid));
  process.kill(orphan, "SIGKILL");
});

test("a merged worktree a spared shell sits in is kept: in use by a shell", async () => {
  const { root, merged } = fixture();
  const shell = plantLogin(join(root, "elsewhere", "sit.sh"), "sleep 300\n", { cwd: merged.path });
  await settle();
  assert.match(sweep(root).stdout, /would keep worktree T1: in use by a shell/);
  const res = sweep(root, "--apply");
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /kept worktree T1: in use by a shell/);
  assert.ok(existsSync(merged.path));
  assert.ok(alive(shell.pid));
});

// ---- fix round 4 (R1b-7 re-verify): sweep signals only what it can prove is the stray's ----

/** A detached shell outside the run directory (no terminal, leads a group) running `body`; its background jobs
 *  share its group. The whole group is killed when the tests end. */
function plantLeader(body) {
  const dir = mkdtempSync(join(tmpdir(), "sweep-lead-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "leader.sh");
  writeFileSync(file, body);
  const leader = spawn("/bin/sh", [file], { stdio: "ignore", cwd: tmpdir(), detached: true });
  children.push(leader);
  cleanups.push(() => {
    try {
      process.kill(-leader.pid, "SIGKILL");
    } catch {
      // gone
    }
  });
  return leader;
}
/** The pid of the process in `group` whose command line matches `pattern`. */
const inGroup = (group, pattern) =>
  Number(
    spawnSync("pgrep", ["-g", String(group), "-f", pattern], { encoding: "utf8" })
      .stdout.split("\n")[0]
      .trim(),
  );
const strayScript = (root, name, body = "sleep 300\n") => {
  const file = runFile(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
};

test("a stray under a leader that is not a stray leaves the leader and its other children alone", async () => {
  const { root } = fixture();
  const script = strayScript(root, "runs/T1/under-leader.sh");
  const leader = plantLeader(`/bin/sh ${script} &\nsleep 311 &\nwait\n`);
  await settle();
  const stray = inGroup(leader.pid, "under-leader.sh");
  const bystander = inGroup(leader.pid, "sleep 311");
  assert.ok(stray > 0 && bystander > 0, "the leader should have started both");
  const res = sweep(root, "--apply", "--json");
  assert.equal(res.status, 0, res.stdout);
  assert.ok(await waitDead(stray), "the stray goes");
  assert.ok(alive(bystander), "a bystander in the stray's group is not the stray's");
  assert.ok(alive(leader.pid), "a no-terminal group leader above the stray is not the stray's");
});

test("a live lane's process in the stray's group or tree survives", async () => {
  const { root, live } = fixture();
  const script = strayScript(
    root,
    "runs/T1/near-live.sh",
    `(cd ${live.path} && exec sleep 313) &\nsleep 300\n`,
  );
  const leader = plantLeader(`(cd ${live.path} && exec sleep 312) &\n/bin/sh ${script} &\nwait\n`);
  await settle();
  const inTree = inGroup(leader.pid, "sleep 313");
  const inSameGroup = inGroup(leader.pid, "sleep 312");
  const stray = inGroup(leader.pid, "near-live.sh");
  assert.ok(inTree > 0 && inSameGroup > 0 && stray > 0);
  const res = sweep(root, "--apply", "--json");
  assert.equal(res.status, 0, res.stdout);
  assert.ok(await waitDead(stray));
  assert.ok(alive(inSameGroup), "a live lane's process in the group must survive");
  assert.ok(alive(inTree), "a live lane's process in the stray's tree must survive");
});

test("a stray that leads its group is stopped with the group, and the dry run lists all of it", async () => {
  const { root } = fixture();
  const script = strayScript(root, "runs/T1/leads.sh", "( sleep 300 & )\nsleep 300\n");
  const leader = spawn("/bin/sh", [script], { stdio: "ignore", detached: true });
  children.push(leader);
  await settle();
  const orphan = sleepsIn(leader.pid).find((pid) => pid !== childOf(leader.pid));
  assert.ok(orphan, "the group should hold a sleep that is not the stray's child");
  const dry = sweep(root).stdout;
  assert.match(dry, new RegExp(`would stop process ${leader.pid}`));
  assert.match(dry, new RegExp(`with process ${orphan}`));
  const res = sweep(root, "--apply", "--json");
  assert.ok(JSON.parse(res.stdout).result.signalled.includes(orphan), "the result names it");
  assert.ok(await waitDead(orphan));
});

test("the sweep's whole ancestor chain is spared, not only its parent", async () => {
  const { root, merged } = fixture();
  const dir = mkdtempSync(join(tmpdir(), "sweep-anc-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const done = join(dir, "reached");
  const caller = join(dir, "caller.sh");
  writeFileSync(
    caller,
    `cd ${merged.path}\nsh -c 'node ${LANE} sweep --apply --root ${root} >/dev/null 2>&1; :'\necho reached > ${done}\n`,
  );
  const child = spawn("/bin/sh", [caller], {
    stdio: "ignore",
    cwd: tmpdir(),
    env: { ...process.env, ...gitEnv, NO_COLOR: "1" },
  });
  children.push(child);
  await new Promise((r) => child.once("exit", r));
  assert.ok(existsSync(done), "the caller shell, in a merged worktree, must outlive the sweep");
});

// The leftovers a killed writer and killed holders leave in `root`, next to what is live and must stay:
// `{ group, live }` (a detached group a dead run left running; a live session process).
function leftoversIn(root) {
  // The group is left behind by a parent that exits at once, so it is reaped when it dies (a child of this
  // test would stay a zombie while the sweep runs, and a zombie still counts as running).
  const spawned = spawnSync(
    "node",
    [
      "-e",
      "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref()",
    ],
    { encoding: "utf8" },
  );
  const group = { pid: Number(spawned.stdout) };
  planted.push(group.pid);
  const live = spawn("node", ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  children.push(live);
  cleanups.push(() => {
    try {
      process.kill(-group.pid, "SIGKILL");
    } catch {
      // gone already
    }
  });
  const dead = spawnSync("node", ["-e", ""]).pid;
  const ledgerDir = runFile(root, join("process", "ledger"));
  mkdirSync(ledgerDir, { recursive: true });
  // The dead writer's temp sits beside the drafts: the ledger's own reads (the sweep lists the ledgers)
  // would sweep one in the ledger directory before the sweep could list it.
  writeFileSync(runFile(root, join("process", `drafts.jsonl.agentry-${dead}.tmp`)), "{");
  writeFileSync(join(ledgerDir, `T2.json.agentry-${live.pid}.tmp`), "{");
  // editor: a dead run whose command's group still runs; sim: a take of a live session; ttl: a pid-less
  // take within its until; reused: a slot whose pid now names another process.
  tryLock(root, "editor", { slots: 1, pid: dead, who: "run" });
  setGroup(root, "editor", 1, group.pid, dead);
  tryLock(root, "sim", { slots: 1, pid: live.pid, who: "T-1", ttlMs: 60_000 });
  tryLock(root, "ttl", { slots: 1, pid: null, who: "T-2", ttlMs: 60_000 });
  mkdirSync(lockDir(root, "reused"), { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(
    join(lockDir(root, "reused"), "slot-1.lock"),
    JSON.stringify({ pid: live.pid, start: "wrong", who: "old", at }),
  );
  writeFileSync(
    join(lockDir(root, "ttl"), "slot-1.lock.write"),
    JSON.stringify({ pid: dead, start: "x", token: 1 }),
  );
  mkdirSync(gateLockDir(root), { recursive: true });
  writeFileSync(
    join(gateLockDir(root), "slot-1.lock"),
    JSON.stringify({ ...identity(dead), who: "lane gone", at }),
  );
  return { group, live, dead };
}

test("the sweep lists dead writers' temp files, dead holders' slots with the groups they left, and stale write-locks; the preview changes nothing", () => {
  const repo = boardRepo();
  cleanups.push(repo.cleanup);
  const { root } = repo;
  const { group, live, dead } = leftoversIn(root);
  const found = JSON.parse(sweep(root, "--json").stdout);
  assert.deepEqual(found.temps, [
    runFile(root, join("process", `drafts.jsonl.agentry-${dead}.tmp`)),
  ]);
  assert.deepEqual(
    found.slots.map((s) => [s.lock, s.slot, s.groups]),
    [
      ["gate", 1, []],
      ["editor", 1, [group.pid]],
      ["reused", 1, []],
    ],
    "a live session's take and a pid-less take within its until are never listed",
  );
  assert.deepEqual(found.writeLocks, [join(lockDir(root, "ttl"), "slot-1.lock.write")]);
  const text = sweep(root).stdout;
  assert.match(
    text,
    /would free lock editor slot 1: its holder is gone\n {4}group \d+ still running: would stop/,
  );
  assert.match(text, /would free gate slot 1: its holder is gone/);
  assert.match(text, /would remove stale write-lock .*slot-1\.lock\.write/);
  assert.match(
    text,
    /would remove temp file .*drafts\.jsonl\.agentry-\d+\.tmp: its writer is gone/,
  );
  assert.ok(alive(group.pid), "nothing was stopped");
  assert.ok(existsSync(join(lockDir(root, "editor"), "slot-1.lock")));
  assert.ok(alive(live.pid));
});

test("--apply stops a dead run's group and frees its slot, removes dead temps and write-locks, and leaves every live one", async () => {
  const repo = boardRepo();
  cleanups.push(repo.cleanup);
  const { root } = repo;
  const { group, live } = leftoversIn(root);
  const res = sweep(root, "--apply", "--json");
  assert.equal(res.status, 0, res.stdout);
  const { result } = JSON.parse(res.stdout);
  assert.deepEqual(result.stoppedGroups, [group.pid]);
  assert.equal(result.freedSlots.length, 3);
  assert.deepEqual(result.keptSlots, []);
  assert.equal(result.removedTemps.length, 1);
  assert.equal(result.removedWriteLocks.length, 1);
  assert.ok(await waitDead(group.pid), "the group is gone");
  assert.deepEqual(readdirSync(lockDir(root, "editor")), []);
  assert.deepEqual(readdirSync(lockDir(root, "reused")), [], "a reused pid read dead");
  assert.deepEqual(
    readdirSync(lockDir(root, "sim")),
    ["slot-1.lock"],
    "a live holder's slot stays",
  );
  assert.deepEqual(
    readdirSync(lockDir(root, "ttl")),
    ["slot-1.lock"],
    "a pid-less take within its until stays",
  );
  assert.deepEqual(readdirSync(gateLockDir(root)), []);
  assert.deepEqual(readdirSync(runFile(root, join("process", "ledger"))), [
    `T2.json.agentry-${live.pid}.tmp`,
  ]);
  assert.ok(!readdirSync(runFile(root, "process")).some((f) => f.endsWith(".tmp")));
  assert.match(sweep(root).stdout, /nothing to clean/);
});

test("kill -9 of agentry run leaves its slot and group to the sweep, which stops the group and frees the slot", async () => {
  const repo = boardRepo();
  cleanups.push(repo.cleanup);
  const { root } = repo;
  writeFileSync(join(root, ".agentry", "workflow.json"), JSON.stringify({ locks: { editor: 1 } }));
  const pidFile = join(root, "cmd.pid");
  const bin = join(dirname(LANE), "..", "bin", "agentry");
  const run = spawn(
    "node",
    [
      bin,
      "run",
      "--limit",
      "60s",
      "--lock",
      "editor",
      "--",
      "node",
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
    ],
    { cwd: root, stdio: "ignore", env: { ...gitEnv, CLAUDE_PID: "" } },
  );
  for (let i = 0; i < 100 && !(existsSync(pidFile) && readFileSync(pidFile, "utf8")); i++)
    await new Promise((r) => setTimeout(r, 50));
  const pgid = Number(readFileSync(pidFile, "utf8"));
  planted.push(pgid);
  cleanups.push(() => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // gone already
    }
  });
  run.kill("SIGKILL");
  await new Promise((resolve) => run.on("exit", resolve));
  assert.ok(alive(pgid), "the command outlives its run");
  const res = sweep(root, "--apply");
  assert.equal(res.status, 0, res.stdout);
  assert.match(
    res.stdout,
    new RegExp(`freed lock editor slot 1: its holder is gone\n {4}group ${pgid} stopped`),
  );
  assert.ok(await waitDead(pgid));
  assert.deepEqual(readdirSync(lockDir(root, "editor")), []);
  const held = holdGate(gateLockDir(root), { waitSec: 0 });
  held.release();
});

test("the preview lists a dead writer's temp file in the ledger directory and leaves it; --apply removes it", () => {
  const { root } = fixture();
  const dead = spawnSync("node", ["-e", ""]).pid;
  const temp = join(runFile(root, join("process", "ledger")), `T1.json.agentry-${dead}.tmp`);
  writeFileSync(temp, "{half");
  const preview = JSON.parse(sweep(root, "--json").stdout);
  assert.deepEqual(preview.temps, [temp]);
  assert.ok(existsSync(temp), "the preview changed nothing");
  const applied = JSON.parse(sweep(root, "--apply", "--json").stdout);
  assert.deepEqual(applied.result.removedTemps, [temp]);
  assert.ok(!existsSync(temp));
});

test("the sweep lists and removes the older temp naming a killed ledger or drafts writer left", () => {
  const { root } = fixture();
  const dead = spawnSync("node", ["-e", ""]).pid;
  const old = [
    join(runFile(root, join("process", "ledger")), `T2.json.${dead}.tmp`),
    runFile(root, join("process", `drafts.jsonl.${dead}.tmp`)),
  ];
  for (const file of old) writeFileSync(file, "{half");
  assert.deepEqual(JSON.parse(sweep(root, "--json").stdout).temps.sort(), [...old].sort());
  assert.ok(
    old.every((file) => existsSync(file)),
    "the preview changed nothing",
  );
  sweep(root, "--apply");
  assert.ok(!old.some((file) => existsSync(file)));
});

test("the sweep lists and removes a gate slot temp file of the older naming a killed writer left", () => {
  const { root } = fixture();
  const dead = spawnSync("node", ["-e", ""]).pid;
  mkdirSync(gateLockDir(root), { recursive: true });
  const old = join(gateLockDir(root), `slot-1.lock.${dead}.tmp`);
  writeFileSync(old, "{half");
  assert.deepEqual(JSON.parse(sweep(root, "--json").stdout).temps, [old]);
  assert.ok(existsSync(old), "the preview changed nothing");
  sweep(root, "--apply");
  assert.ok(!existsSync(old));
});

test("one --apply leaves nothing of a stray that forks a child on SIGTERM whose parent leaves at once", async () => {
  const { root } = fixture();
  const cwd = runFile(root, "scratch");
  mkdirSync(cwd, { recursive: true });
  const late = join(cwd, "late.pid");
  const src = `process.on("SIGTERM", () => { require("child_process").spawn("sh", ["-c", "sleep 301 & echo $! > ${late}"], { stdio: "ignore" }); }); setInterval(() => {}, 1000);`;
  const stray = spawn("node", ["-e", src], { cwd, stdio: "ignore" });
  children.push(stray);
  await settle();
  const res = JSON.parse(sweep(root, "--apply", "--json").stdout);
  assert.ok(res.result.killed.includes(stray.pid), "the stray was stopped");
  assert.deepEqual(res.result.survivors, []);
  const forked = existsSync(late) ? Number(readFileSync(late, "utf8")) : null;
  if (forked) planted.push(forked);
  assert.ok(await waitDead(stray.pid));
  assert.equal(forked === null || !alive(forked), true, `its child ${forked} outlived the sweep`);
  const left = spawnSync("pgrep", ["-f", "sleep 301"], { encoding: "utf8" }).stdout.trim();
  assert.equal(left, "", "no sleep 301 runs");
});
