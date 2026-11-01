// Tests for lib/lane/land.mjs on throwaway repositories: what a branch has to land, the cherry-pick that
// aborts on any stop, the rollback's two guards, the board commit's exactness, the attribution check, the
// push without an upstream and the cleanup's refusals. (`merge-cli.test.mjs` runs them as one land.)
// Run: node --test plugin/scripts/test/land.test.mjs
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  attributionIn,
  boardCommit,
  cherryPick,
  cleanup,
  push,
  rollback,
  toLand,
} from "../lib/lane/land.mjs";
import { create } from "../lib/lane/worktree.mjs";
import { commitFile, git, gitEnv, tempRepo } from "./git-repo.mjs";

// The library's own git calls (cherry-pick, commit) need the fixture's identity, not the developer's.
Object.assign(process.env, gitEnv);

let repo;
beforeEach(() => {
  repo = tempRepo();
});
afterEach(() => repo.cleanup());

const head = () => git(repo.dir, "rev-parse", "HEAD");
/** A branch `b` off main with one commit per file. */
function branch(files) {
  writeFileSync(join(repo.dir, ".git", "info", "exclude"), ".agentry/\n"); // the worktree lives there
  git(repo.dir, "branch", "b");
  const { path } = create(repo.dir, { id: "B", base: "b" });
  git(path, "checkout", "-q", "b");
  return Object.entries(files).map(([file, text]) => commitFile(path, file, text));
}

test("toLand lists the picks oldest first and leaves out what is already on main by patch", () => {
  const [one, two] = branch({ "a.txt": "a\n", "b.txt": "b\n" });
  commitFile(repo.dir, "main.txt", "main moved\n");
  git(repo.dir, "cherry-pick", one); // landed by hand, as a new commit
  const plan = toLand(repo.dir, { main: "main", branch: "b" });
  assert.deepEqual(plan.picks, [two]);
  assert.deepEqual(plan.onMain, [one]);
  assert.deepEqual(plan.merges, []);
  assert.match(toLand(repo.dir, { main: "main", branch: "nope" }).error, /not a commit/);
});

test("cherryPick lands the commits as new ones on main", () => {
  const shas = branch({ "a.txt": "a\n", "b.txt": "b\n" });
  const preHead = head();
  const res = cherryPick(repo.dir, { shas, preHead });
  assert.equal(res.ok, true);
  assert.equal(res.landed.length, 2);
  assert.equal(git(repo.dir, "rev-parse", "HEAD~2"), preHead);
});

test("cherryPick aborts a sequence that stops midway: main is back at preHead", () => {
  const shas = branch({ "ok.txt": "fine\n", "c.txt": "branch\n" });
  commitFile(repo.dir, "c.txt", "main\n");
  const preHead = head();
  const res = cherryPick(repo.dir, { shas, preHead });
  assert.equal(res.ok, false);
  assert.equal(res.stopped, shas[1]);
  assert.equal(res.restored, true);
  assert.equal(head(), preHead);
  assert.equal(existsSync(join(repo.dir, "ok.txt")), false);
});

test("rollback refuses when main holds more than the landed commits, or is not clean", () => {
  const preHead = head();
  const landed = [commitFile(repo.dir, "a.txt", "a\n")];
  commitFile(repo.dir, "someone-else.txt", "x\n");
  assert.match(rollback(repo.dir, { preHead, landed }).reason, /not exactly the 1 landed/);
  git(repo.dir, "reset", "-q", "--hard", landed[0]);
  writeFileSync(join(repo.dir, "left.txt"), "left by the gate\n");
  assert.match(rollback(repo.dir, { preHead, landed }).reason, /not clean/);
  assert.equal(head(), landed[0]);
});

test("rollback resets to preHead when main is exactly preHead plus the landed commits", () => {
  const preHead = head();
  const landed = [commitFile(repo.dir, "a.txt", "a\n"), commitFile(repo.dir, "b.txt", "b\n")];
  assert.deepEqual(rollback(repo.dir, { preHead, landed }), { ok: true });
  assert.equal(head(), preHead);
});

test("boardCommit commits exactly the named files and refuses any other change", () => {
  commitFile(repo.dir, "board.md", "one\n");
  writeFileSync(join(repo.dir, "board.md"), "two\n");
  writeFileSync(join(repo.dir, "stray.txt"), "x\n");
  const refused = boardCommit(repo.dir, { files: ["board.md"], message: "docs: board" });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /other changes: \?\? stray\.txt/);
  git(repo.dir, "clean", "-q", "-f");
  const res = boardCommit(repo.dir, { files: ["board.md"], message: "docs: board" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.left, []);
  assert.equal(
    git(repo.dir, "show", "--name-only", "--format=%s", "HEAD"),
    "docs: board\n\nboard.md",
  );
});

test("attributionIn finds an AI credit on any line and passes a plain message", () => {
  for (const line of [
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "co-authored-by: GPT-4 <x@y>",
    "Claude-Session: https://claude.ai/code/x",
    "Generated with Claude Code",
    "🤖 done",
  ])
    assert.equal(attributionIn(`docs(board): land T1\n\n${line}`), line, line);
  assert.equal(
    attributionIn("docs(board): land T1\n\nCo-Authored-By: Ada <ada@example.com>"),
    null,
  );
  assert.equal(attributionIn("fix(ai-engine): steer the guards"), null);
});

test("push refuses a branch with no upstream", () => {
  assert.match(push(repo.dir, { branch: "main" }).reason, /no upstream/);
});

test("cleanup keeps a worktree with uncommitted work, and its branch", () => {
  branch({ "a.txt": "a\n" });
  const path = join(repo.dir, ".agentry", "run", "worktrees", "B");
  writeFileSync(join(path, "wip.txt"), "unsaved\n");
  const res = cleanup(repo.dir, { branch: "b", main: "main", fallbackPath: path });
  assert.equal(res.ok, false);
  assert.match(res.reason, /uncommitted changes/);
  assert.ok(existsSync(path));
});

test("cleanup keeps a branch whose commits are not on main", () => {
  branch({ "a.txt": "a\n" });
  const res = cleanup(repo.dir, { branch: "b", main: "main", fallbackPath: "/nowhere" });
  assert.equal(res.removed, true);
  assert.equal(res.ok, false);
  assert.match(res.reason, /not on main/);
  assert.notEqual(git(repo.dir, "branch", "--list", "b"), "");
});
