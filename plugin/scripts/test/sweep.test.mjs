// Tests for `lane sweep` (lib/lane/sweep.mjs, cli/sweep.mjs): merged tasks' worktrees go, unknown ones and
// live tasks' stay, a process under `.agentry/run/` is stopped only with --apply, and low disk warns.
// Run: node --test plugin/scripts/test/sweep.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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
/** A long-lived node process whose command line carries `marker`. */
function plant(marker) {
  const child = spawn("node", ["-e", "setTimeout(() => {}, 300000)", marker], { stdio: "ignore" });
  children.push(child);
  return child;
}

test("a dry run reports merged worktrees, unknown ones and strays, and changes nothing", () => {
  const { root, merged, stranger } = fixture();
  const stray = plant(join(root, ".agentry", "run", "marker-dry"));
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

test("--apply stops a process under .agentry/run/ and leaves one outside it", async () => {
  const { root } = fixture();
  const inside = plant(join(root, ".agentry", "run", "marker-kill"));
  const outside = plant(join(root, "elsewhere", "marker-keep"));
  await new Promise((r) => setTimeout(r, 300));
  const res = sweep(root, "--apply");
  assert.equal(res.status, 0, res.stderr);
  assert.ok(await waitDead(inside.pid), "the process under .agentry/run/ should be stopped");
  assert.ok(alive(outside.pid), "a process outside it must be left alone");
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
