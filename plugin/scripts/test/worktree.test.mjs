// Tests for lib/lane/worktree.mjs on throwaway git repositories.
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  create,
  findByBranch,
  idProblem,
  ignoredFiles,
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

test("porcelain lists untracked files one by one, renames once, nothing when clean", () => {
  assert.deepEqual(porcelain(repo.dir), []);
  writeFileSync(join(repo.dir, "new.txt"), "x");
  git(repo.dir, "mv", "README.md", "MOVED.md");
  assert.deepEqual(porcelain(repo.dir).sort(), ["?? new.txt", "R  MOVED.md"]);
  commitFile(repo.dir, "d/a.txt", "a");
  writeFileSync(join(repo.dir, "d", "b.txt"), "b");
  assert.ok(porcelain(repo.dir).includes("?? d/b.txt"));
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
