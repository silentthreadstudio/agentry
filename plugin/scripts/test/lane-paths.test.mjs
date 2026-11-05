// Tests for lib/lane/paths.mjs, the one confinement check the lane's steps use: a repo-relative path that
// leaves the repository, and an absolute path inside a directory. The cases where the old copies disagreed
// are pinned here: the stricter `..` rule now also guards the carry, and a child named `..x` is inside.
// Run: node --test plugin/scripts/test/lane-paths.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planRows, putCells } from "../lib/lane/carry-io.mjs";
import { normalised } from "../lib/lane/exec/lane.mjs";
import { insideDir, leaves } from "../lib/lane/paths.mjs";

test("leaves refuses a leading slash and any .. segment, even one that comes back in", () => {
  assert.equal(leaves("/x"), true);
  assert.equal(leaves("a/../.."), true);
  assert.equal(leaves("a/../b"), true);
  assert.equal(leaves(".."), true);
  assert.equal(leaves("a/b.md"), false);
  assert.equal(leaves("..x/b.md"), false); // a name that starts with dots is no `..` segment
});

test("leaves judges an owns path in its normalised form, so .//etc is /etc", () => {
  assert.equal(leaves(normalised(".//etc/passwd")), true);
  assert.equal(leaves(normalised("./plugin/x.mjs")), false);
});

test("insideDir is strict: the directory itself and anything above it are not inside", () => {
  const dir = join(tmpdir(), "lane-paths-dir");
  assert.equal(insideDir(dir, join(dir, "a", "b")), true);
  assert.equal(insideDir(dir, "a/b"), true); // relative to `dir`
  assert.equal(insideDir(dir, dir), false);
  assert.equal(insideDir(dir, join(dir, "..", "x")), false);
  assert.equal(insideDir(dir, "/etc/passwd"), false);
});

// The admission's and the legacy record's copies tested `rel.startsWith("..")`, which put a child named
// `..cache` outside: a nested worktree there went unnoticed.
test("insideDir takes a child whose name starts with .. as inside", () => {
  const dir = join(tmpdir(), "lane-paths-dir");
  assert.equal(insideDir(dir, join(dir, "..cache")), true);
  assert.equal(insideDir(dir, "..cache/x.patch"), true);
});

// The carry's copy used `escapesRoot`, which lets `a/../b` through as `b`. A ledger path never holds a
// `..` the board writer made, so the stricter rule refuses it.
test("the carry refuses a ledger path with a .. segment that stays inside the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-paths-"));
  try {
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "b.md"), "## T\n\n| id | what |\n|---|---|\n| T-1 | one |\n");
    const row = { file: "a/../b.md", heading: "T", header: ["id", "what"], idColumn: "id" };
    const plan = planRows(root, [{ ...row, key: "T-2", prev: "T-1", text: "| T-2 | two |" }]);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /a\/\.\.\/b\.md leaves the repository/);
    const put = putCells(root, {}, [{ file: "a/../b.md", from: "one", to: "ONE" }]);
    assert.equal(put.ok, false);
    assert.match(put.reason, /leaves the repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
