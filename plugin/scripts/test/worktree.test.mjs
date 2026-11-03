// Tests for lib/lane/worktree.mjs on throwaway git repositories.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  create,
  findByBranch,
  idProblem,
  ignoredFiles,
  git as laneGit,
  mainRoot,
  porcelain,
  remove,
} from "../lib/lane/worktree.mjs";
import { commitFile, git, tempRepo } from "./git-repo.mjs";

let repo;
beforeEach(() => {
  repo = tempRepo();
});
afterEach(() => repo.cleanup());

test("create adds worktree and branch agentry/<id> under .agentry/run/worktrees", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  assert.equal(made.branch, "agentry/T-1");
  assert.equal(made.path, join(repo.dir, ".agentry", "run", "worktrees", "T-1"));
  assert.equal(git(made.path, "branch", "--show-current"), "agentry/T-1");
  assert.equal(findByBranch(repo.dir, "agentry/T-1"), made.path);
  assert.equal(findByBranch(repo.dir, "agentry/other"), null);
});

test("create refuses ids with .. or .lock or odd characters, before touching git", () => {
  for (const id of ["a..b", "../x", "x.lock", "x.lock.y", "a/b", "-x", "", "x."])
    assert.throws(() => create(repo.dir, { id, base: "main" }), /id/, `id "${id}"`);
  assert.equal(git(repo.dir, "branch", "--list", "agentry/*"), "");
  assert.equal(idProblem("R1b-2"), null);
  assert.equal(idProblem("DS.1_a"), null);
});

test("create throws git's error when the branch already exists", () => {
  create(repo.dir, { id: "T-1", base: "main" });
  assert.throws(() => create(repo.dir, { id: "T-1", base: "main" }), /already/);
});

test("mainRoot from inside a worktree is the main checkout", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  assert.equal(mainRoot(made.path), repo.dir);
  assert.equal(mainRoot(repo.dir), repo.dir);
  assert.equal(mainRoot(join(made.path)), repo.dir);
});

test("mainRoot is null outside a repository", () => {
  assert.equal(mainRoot("/"), null);
});

test("porcelain lists untracked files one by one, a rename as delete and add, nothing when clean", () => {
  assert.deepEqual(porcelain(repo.dir), []);
  writeFileSync(join(repo.dir, "new.txt"), "x");
  git(repo.dir, "mv", "README.md", "MOVED.md");
  assert.deepEqual(
    porcelain(repo.dir).sort(),
    ["?? new.txt", "A  MOVED.md", "D  README.md"].sort(),
  );
  commitFile(repo.dir, "d/a.txt", "a");
  writeFileSync(join(repo.dir, "d", "b.txt"), "b");
  assert.ok(porcelain(repo.dir).includes("?? d/b.txt"));
});

test('porcelain keeps the status columns of the first entry (an unstaged edit is " M")', () => {
  writeFileSync(join(repo.dir, "README.md"), "changed\n");
  assert.deepEqual(porcelain(repo.dir), [" M README.md"]);
});

test("ignoredFiles lists ignored files and collapses ignored directories", () => {
  commitFile(repo.dir, ".gitignore", "out/\n*.log\n");
  writeFileSync(join(repo.dir, "a.log"), "x");
  commitFile(repo.dir, "keep.txt", "k");
  writeFileSync(join(repo.dir, "b.log"), "x");
  assert.deepEqual(ignoredFiles(repo.dir).sort(), ["a.log", "b.log"]);
});

test("remove deletes a worktree and its fully merged branch", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  commitFile(made.path, "f.txt", "f");
  git(repo.dir, "merge", "-q", "--ff-only", "agentry/T-1");
  const res = remove(repo.dir, made);
  assert.deepEqual(res, { removed: true, branchDeleted: true });
  assert.equal(existsSync(made.path), false);
  assert.equal(git(repo.dir, "branch", "--list", "agentry/T-1"), "");
});

test("remove keeps the branch when a commit is not on main, and says why", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  commitFile(made.path, "f.txt", "f");
  const res = remove(repo.dir, made);
  assert.equal(res.removed, true);
  assert.equal(res.branchDeleted, false);
  assert.match(res.reason, /not on main/);
  assert.equal(git(repo.dir, "branch", "--list", "agentry/T-1").includes("agentry/T-1"), true);
});

test("remove deletes the branch when its commits were cherry-picked onto main", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  const sha = commitFile(made.path, "f.txt", "f");
  commitFile(repo.dir, "other.txt", "o"); // main moves, so the pick is a new commit with the same patch
  git(repo.dir, "cherry-pick", sha);
  const res = remove(repo.dir, made);
  assert.deepEqual(res, { removed: true, branchDeleted: true });
});

test("remove takes down a locked worktree (-f -f)", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  git(repo.dir, "worktree", "lock", "--reason", "agent running", made.path);
  const res = remove(repo.dir, made);
  assert.equal(res.removed, true);
  assert.equal(existsSync(made.path), false);
  assert.equal(findByBranch(repo.dir, "agentry/T-1"), null);
});

test("remove copes with a worktree directory that is already gone", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  rmSync(made.path, { recursive: true });
  const res = remove(repo.dir, made);
  assert.equal(res.removed, true);
  assert.equal(findByBranch(repo.dir, "agentry/T-1"), null);
});

test("remove refuses a worktree with uncommitted changes unless forced", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  writeFileSync(join(made.path, "wip.txt"), "uncommitted");
  const res = remove(repo.dir, made);
  assert.equal(res.removed, false);
  assert.match(res.reason, /uncommitted changes.*wip\.txt/);
  assert.equal(existsSync(join(made.path, "wip.txt")), true);
  const forced = remove(repo.dir, { ...made, force: true });
  assert.equal(forced.removed, true);
  assert.equal(existsSync(made.path), false);
});

test("remove prunes a locked worktree whose directory is gone, and still decides the branch", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  commitFile(made.path, "f.txt", "f");
  git(repo.dir, "worktree", "lock", "--reason", "agent running", made.path);
  rmSync(made.path, { recursive: true });
  const res = remove(repo.dir, made);
  assert.equal(res.removed, true);
  assert.equal(findByBranch(repo.dir, "agentry/T-1"), null);
  assert.equal(git(repo.dir, "worktree", "list").includes("T-1"), false);
  assert.equal(res.branchDeleted, false);
  assert.match(res.reason, /not on main/);
});

// A merge commit carries content `git cherry` cannot see (it skips merges), so a branch holding one is
// deleted only when everything it changed since the merge-base is already on main.
function sideBranch(name, { land }) {
  git(repo.dir, "branch", name, "main");
  const side = join(repo.dir, "..", `${name}-${process.pid}`);
  git(repo.dir, "worktree", "add", "-q", side, name);
  const sha = commitFile(side, `${name}.txt`, "side\n");
  if (land) git(repo.dir, "cherry-pick", sha);
  return () => git(repo.dir, "worktree", "remove", "-f", side);
}

test("remove keeps a branch whose merge commit brings in a file that is not on main", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  const done = sideBranch("side", { land: false });
  git(made.path, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  done();
  const res = remove(repo.dir, made);
  assert.equal(res.branchDeleted, false);
  assert.match(res.reason, /not on main/);
  assert.notEqual(git(repo.dir, "branch", "--list", "agentry/T-1"), "");
});

test("remove keeps a branch whose merge commit adds content that is in no parent", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  const done = sideBranch("side", { land: true });
  git(made.path, "merge", "-q", "--no-ff", "--no-commit", "side");
  writeFileSync(join(made.path, "evil.txt"), "only in the merge\n");
  git(made.path, "add", "evil.txt");
  git(made.path, "commit", "-q", "-m", "merge side");
  done();
  const res = remove(repo.dir, made);
  assert.equal(res.branchDeleted, false);
  assert.notEqual(git(repo.dir, "branch", "--list", "agentry/T-1"), "");
});

test("remove deletes a branch with a merge commit when all its content is already on main", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  const done = sideBranch("side", { land: true });
  git(made.path, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  done();
  assert.equal(remove(repo.dir, made).branchDeleted, true);
});

test("remove deletes a branch whose own work landed on main and whose extra commit merges main in", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  const sha = commitFile(made.path, "a.txt", "1\n");
  commitFile(repo.dir, "other.txt", "o\n");
  git(repo.dir, "cherry-pick", sha);
  git(made.path, "merge", "-q", "--no-edit", "main");
  assert.equal(remove(repo.dir, made).branchDeleted, true);
});

test("remove keeps a branch that merged main in but holds work main does not have", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  commitFile(made.path, "a.txt", "1\n");
  commitFile(repo.dir, "other.txt", "o\n");
  git(made.path, "merge", "-q", "--no-edit", "main");
  assert.equal(remove(repo.dir, made).branchDeleted, false);
});

test("remove keeps a squash-merged branch (patch ids differ: the safe direction)", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  commitFile(made.path, "a.txt", "1\n");
  commitFile(made.path, "b.txt", "2\n");
  git(repo.dir, "merge", "-q", "--squash", "agentry/T-1");
  git(repo.dir, "commit", "-q", "-m", "squash");
  assert.equal(remove(repo.dir, made).branchDeleted, false);
});

test("remove deletes a fast-forwarded branch", () => {
  const made = create(repo.dir, { id: "T-1", base: "main" });
  commitFile(made.path, "a.txt", "1\n");
  git(repo.dir, "merge", "-q", "--ff-only", "agentry/T-1");
  assert.equal(remove(repo.dir, made).branchDeleted, true);
});

// ---- the lane's git never hangs: no stdin unless given, a timeout, no child left behind ----

// Run `body` with a fake `git` first on PATH; `script` is its /bin/sh body, with $LOG naming a file in `dir`.
function withFakeGit(script, body) {
  const dir = mkdtempSync(join(tmpdir(), "lane-fakegit-"));
  writeFileSync(join(dir, "git"), `#!/bin/sh\nLOG="${dir}/log"\n${script}\n`);
  chmodSync(join(dir, "git"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved}`;
  try {
    return body(dir);
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("git gets no stdin unless it is given input", () => {
  // A stdin of `ignore` is /dev/null, a character device; one the parent writes to is a pipe or socket.
  const script = '[ -c /dev/stdin ] && echo none >> "$LOG" || echo open >> "$LOG"; cat > /dev/null';
  withFakeGit(script, (dir) => {
    assert.equal(laneGit(dir, ["status"]).status, 0);
    assert.equal(laneGit(dir, ["apply"], "patch").status, 0);
    assert.equal(readFileSync(join(dir, "log"), "utf8"), "none\nopen\n");
  });
});

test("git past its timeout is killed, answers non-zero and leaves no child", () => {
  withFakeGit('echo $$ > "$LOG"; exec sleep 60', (dir) => {
    const started = Date.now();
    const res = laneGit(dir, ["status"], undefined, { timeout: 1500 });
    assert.notEqual(res.status, 0);
    assert.ok(Date.now() - started < 10_000);
    const pid = Number(readFileSync(join(dir, "log"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
});

test("git slower than a moment still succeeds under the default timeout", () => {
  withFakeGit("sleep 2; echo done", (dir) => {
    const res = laneGit(dir, ["status"]);
    assert.deepEqual([res.status, res.stdout], [0, "done\n"]);
  });
});
