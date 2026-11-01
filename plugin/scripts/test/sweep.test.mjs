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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LOW_DISK, plan } from "../lib/lane/sweep.mjs";
import { boardRepo, builtBranch, handBranch, ledger } from "./drift-repo.mjs";
import { git, gitEnv } from "./git-repo.mjs";

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");
const cleanups = [];
const children = [];
after(() => {
  for (const c of children) c.kill("SIGKILL");
  for (const c of cleanups) c();
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

test("--apply removes only the merged task's worktree, and leaves live and unknown ones", () => {
  const { root, merged, live, stranger } = fixture();
  const res = sweep(root, "--apply", "--json");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).applied.removed[0].id, "T1");
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
  assert.deepEqual(JSON.parse(res.stdout).applied.survived, []);
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
