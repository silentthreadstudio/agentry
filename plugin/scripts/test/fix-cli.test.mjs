// Tests for `board fix` (lib/process/cli/fix.mjs): it writes only the mechanical items through the lifecycle,
// `--dry-run` writes nothing, a second run finds nothing, and what it cannot decide is reported.
// Run: node --test plugin/scripts/test/fix-cli.test.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  SPEC,
  board,
  boardRepo,
  builtBranch,
  handBranch,
  ledger,
  pickOntoMain,
  read,
} from "./drift-repo.mjs";
import { commitFile, git } from "./git-repo.mjs";

const cleanups = [];
after(() => {
  for (const c of cleanups) c();
});
// T1 is the task under test; T3 is already tracked, so the only nudges are the ones a test makes.
function fresh(opts) {
  const repo = boardRepo(opts);
  cleanups.push(repo.cleanup);
  ledger(repo.root, "T3");
  return repo;
}
const files = (root) => ({
  board: read(root, "plan/BOARD.md"),
  sprint: read(root, "plan/sprints/S1.md"),
});
const row = (text, id) => text.split("\n").find((l) => l.startsWith(`| ${id} `));

// T1 built on its branch and cherry-picked to main; a ledger with the merge record. Returns main's commit.
function landedWithRecord(root, id = "T1") {
  const { sha } = builtBranch(root, id);
  const main = pickOntoMain(root, sha);
  ledger(root, id, { state: "merged", merge: { preHead: "x", landed: [main], step: "done" } });
  return main;
}

test("a merged ledger and a board still at doing: fix writes done, the SHA and the handoff line", () => {
  const { root } = fresh();
  const main = landedWithRecord(root);
  const before = files(root);
  const out = board(root, "fix");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^fixed 1, 0 left for you/);
  const now = files(root);
  const short = main.slice(0, 7);
  assert.match(row(now.board, "T1"), new RegExp(`\\| done +\\| +\\| ${short} +\\|`));
  assert.equal(row(now.board, "T2"), row(before.board, "T2"));
  assert.equal(row(now.board, "T3"), row(before.board, "T3"));
  assert.match(now.sprint, new RegExp(`- \\*\\*T1\\*\\* \\(${short}\\): The first`));
  const check = board(root, "check");
  assert.equal(check.status, 0, check.stdout);
});

test("--dry-run writes nothing and says what it would fix", () => {
  const { root } = fresh();
  landedWithRecord(root);
  const before = files(root);
  const out = board(root, "fix", "--dry-run");
  assert.deepEqual(files(root), before);
  assert.match(out.stdout, /^would fix 1/);
  assert.match(out.stdout, /T1 +status, commit, handoff/);
  assert.equal(out.status, 0, "a task that would be fixed is not a task left for the owner");
});

test("a second run finds nothing to do and leaves the files as they were", () => {
  const { root } = fresh();
  landedWithRecord(root);
  board(root, "fix");
  const once = files(root);
  const again = board(root, "fix");
  assert.match(again.stdout, /^fixed 0, 0 left for you/);
  assert.deepEqual(files(root), once);
});

test("a ledgered branch cherry-picked by hand (no merge record) is fixed with main's commit", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  const main = pickOntoMain(root, sha);
  ledger(root, "T1");
  const out = board(root, "fix");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const short = main.slice(0, 7);
  assert.match(row(read(root, "plan/BOARD.md"), "T1"), new RegExp(`done +\\| +\\| ${short}`));
  assert.ok(!row(read(root, "plan/BOARD.md"), "T1").includes(sha.slice(0, 7)));
  assert.equal(board(root, "check").status, 0);
});

test("done with no SHA: fix adds the SHA and the handoff line and leaves the status", () => {
  const { root } = fresh();
  const main = landedWithRecord(root);
  const text = read(root, "plan/BOARD.md").replace(
    /^\| T1 .*$/m,
    "| T1   | S1     | done   |         |        | The first  |",
  );
  writeFileSync(join(root, "plan", "BOARD.md"), text);
  const out = board(root, "fix", "--json");
  const result = JSON.parse(out.stdout);
  assert.deepEqual(
    result.fixed.map((f) => f.need),
    [["commit", "handoff"]],
  );
  assert.match(
    row(read(root, "plan/BOARD.md"), "T1"),
    new RegExp(`done +\\| +\\| ${main.slice(0, 7)}`),
  );
});

test("a commit cell that names other commits is reported and left alone", () => {
  const { root } = fresh();
  landedWithRecord(root);
  const text = read(root, "plan/BOARD.md").replace(
    /^\| T1 .*$/m,
    "| T1   | S1     | doing  |         | abc1234 | The first  |",
  );
  writeFileSync(join(root, "plan", "BOARD.md"), text);
  const before = files(root);
  const out = board(root, "fix");
  assert.equal(out.status, 1);
  assert.match(out.stdout, /T1: .*cell names other commits.*left alone/);
  assert.deepEqual(files(root), before);
});

test("work picked onto main and then reverted is never written as done", () => {
  for (const record of [false, true]) {
    const { root } = fresh();
    const { sha } = builtBranch(root, "T1");
    const main = pickOntoMain(root, sha);
    git(root, "revert", "--no-edit", main);
    const merge = { preHead: "x", landed: [main], step: "done" };
    ledger(root, "T1", record ? { state: "merged", merge } : { state: "verified" });
    const before = files(root);
    const out = board(root, "fix");
    assert.deepEqual(files(root), before, record ? "with a merge record" : "picked by hand");
    assert.match(out.stdout, /^fixed 0/);
    assert.equal(out.status, 1);
  }
});

test("a ledgered branch merged by hand with --no-ff or fast-forwarded is fixed with its commit", () => {
  for (const how of [["--no-ff", "--no-edit"], ["--ff-only"]]) {
    const { root } = fresh();
    const { branch, sha } = builtBranch(root, "T1");
    if (how[0] === "--no-ff") commitFile(root, "m.txt", "main moved\n", "chore: move");
    git(root, "merge", ...how, branch);
    ledger(root, "T1", { state: "verified" });
    const out = board(root, "fix");
    assert.equal(out.status, 0, `${how[0]}: ${out.stdout}`);
    assert.match(
      row(read(root, "plan/BOARD.md"), "T1"),
      new RegExp(`done +\\| +\\| ${sha.slice(0, 7)}`),
    );
  }
});

test("what is not mechanical is listed with its command, and the exit is 1", () => {
  const { root } = fresh();
  handBranch(root, ".claude/worktrees/agent-z9", "worktree-agent-z9");
  const out = board(root, "fix");
  assert.equal(out.status, 1);
  assert.match(out.stdout, /left for you:/);
  assert.match(out.stdout, /unlisted-worktree agent-z9 → \/agentry:exec <id>/);
  assert.match(out.stdout, /started-by-hand T1 → \/agentry:exec T1/);
  assert.equal(out.stdout.split("\n").filter((l) => /^ {2}\w/.test(l)).length, 2);
});

test("a merge in progress is not touched", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  const main = pickOntoMain(root, sha);
  ledger(root, "T1", { state: "merging", merge: { preHead: "x", landed: [main], step: "gate" } });
  const before = files(root);
  board(root, "fix");
  assert.deepEqual(files(root), before);
});

test("without a lifecycle fix writes nothing and has nothing to report", () => {
  const { lifecycle, ...bare } = SPEC;
  assert.ok(lifecycle);
  const { root } = fresh({ spec: bare });
  landedWithRecord(root);
  const before = files(root);
  const out = board(root, "fix");
  assert.equal(out.status, 0, out.stdout);
  assert.deepEqual(files(root), before);
});

test("fix takes no operands", () => {
  const { root } = fresh();
  const out = board(root, "fix", "--bogus");
  assert.equal(out.status, 2);
});
