// Tests for lib/process/commit-edits.mjs through `board add|set --commit`, in a throwaway git repo made from
// the `write` fixture. A lane's uncommitted "doing" cell is planted in the working tree; the commit must hold
// only the command's own change. Git identity and hooks come from the environment of this test process only.
// Run: node --test plugin/scripts/test/commit-edits.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
import { run as add } from "../lib/process/cli/add.mjs";
import { run as set } from "../lib/process/cli/set.mjs";
import { takeCommit } from "../lib/process/commit-edits.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "write");
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const git = (root, ...args) => {
  const res = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
};
/** A repo holding the fixture, one commit. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "agentry-commit-"));
  temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}
const call = (cli, root, argv) => {
  const { spec } = loadSpec(join(root, "process.json"));
  return cli(argv, { root, spec, model: readProcess({ root, spec }), today: "2026-05-01" });
};
const text = (root, rel) => readFileSync(join(root, rel), "utf8");
const head = (root) => git(root, "rev-parse", "HEAD").trim();
// A lane's status write, left uncommitted: W3 goes to doing.
const laneDoing = (root) =>
  writeFileSync(
    join(root, "board/BOARD.md"),
    text(root, "board/BOARD.md").replace("| W3   | A2     | todo ", "| W3   | A2     | doing"),
  );
const W4 = '{"id":"W4","sprint":"A1","note":"Fourth"}';
const addW4 = (root, ...extra) => call(add, root, ["task", "--fields", W4, "--apply", ...extra]);

test("takeCommit takes --commit and the message after it, and leaves the rest", () => {
  assert.deepEqual(takeCommit(["task", "--apply"]), {
    argv: ["task", "--apply"],
    commit: false,
    message: null,
  });
  assert.deepEqual(takeCommit(["task", "--commit", "--apply"]), {
    argv: ["task", "--apply"],
    commit: true,
    message: null,
  });
  assert.deepEqual(takeCommit(["task", "--apply", "--commit", "docs: add it"]), {
    argv: ["task", "--apply"],
    commit: true,
    message: "docs: add it",
  });
});

test("add --commit commits the new rows and leaves a lane's uncommitted cell uncommitted", () => {
  const root = repo();
  laneDoing(root);
  const before = head(root);
  const res = addW4(root, "--commit");
  assert.equal(res.exit, 0, res.out);
  assert.match(res.out, /committed [0-9a-f]{9}: docs\(board\): add task W4/);
  assert.notEqual(head(root), before);
  assert.equal(git(root, "log", "-1", "--format=%s"), "docs(board): add task W4\n");
  const committed = git(root, "show", "HEAD:board/BOARD.md");
  assert.match(committed, /\| W4 \| A1/);
  assert.match(committed, /\| W3 {3}\| A2 {5}\| todo /, "the lane's cell is not in the commit");
  assert.match(text(root, "board/BOARD.md"), /\| W3 {3}\| A2 {5}\| doing/);
  assert.match(text(root, "board/BOARD.md"), /\| W4 \| A1/);
  assert.equal(git(root, "diff", "--cached", "--name-only"), "", "nothing is left staged");
  assert.equal(git(root, "status", "--porcelain", "--", "board"), " M board/BOARD.md\n");
  const lane = git(root, "diff")
    .split("\n")
    .filter((l) => /^[-+]\|/.test(l));
  assert.equal(lane.length, 2, "the working tree differs from HEAD in the lane's line only");
});

test("set --commit commits one cell of a row whose other cell the lane changed", () => {
  const root = repo();
  laneDoing(root);
  const res = call(set, root, [
    "task",
    "W3",
    "note=Changed",
    "--apply",
    "--commit",
    "docs: reword W3",
  ]);
  assert.equal(res.exit, 0, res.out);
  assert.equal(git(root, "log", "-1", "--format=%s"), "docs: reword W3\n");
  const committed = git(root, "show", "HEAD:board/BOARD.md");
  assert.match(committed, /\| W3 {3}\| A2 {5}\| todo .*Changed/);
  assert.match(text(root, "board/BOARD.md"), /\| W3 {3}\| A2 {5}\| doing.*Changed/);
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
});

test("set --commit uses the default message and --json reports the commit", () => {
  const root = repo();
  const res = call(set, root, ["task", "W3", "status=doing", "--apply", "--commit", "--json"]);
  assert.equal(res.exit, 0, res.out);
  assert.equal(JSON.parse(res.out).commit, head(root));
  assert.equal(git(root, "log", "-1", "--format=%s"), "docs(board): set task W3 status\n");
});

test("without --commit nothing is committed or staged, and --json says commit null", () => {
  const root = repo();
  const before = head(root);
  const res = call(add, root, ["task", "--fields", W4, "--apply", "--json"]);
  assert.equal(res.exit, 0, res.out);
  assert.equal(JSON.parse(res.out).commit, null);
  assert.equal(head(root), before);
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
});

test("the preview with --commit names what it would commit and writes nothing", () => {
  const root = repo();
  const files = ["board/BOARD.md", "board/TASKS.md"].map((f) => text(root, f));
  const res = call(add, root, ["task", "--fields", W4, "--commit"]);
  assert.equal(res.exit, 0, res.out);
  assert.match(res.out, /would commit .*board\/BOARD\.md.*: docs\(board\): add task W4/);
  assert.deepEqual(
    ["board/BOARD.md", "board/TASKS.md"].map((f) => text(root, f)),
    files,
  );
  assert.equal(git(root, "status", "--porcelain", "--", "board"), "");
});

test("refuses when something is already staged, writing nothing", () => {
  const root = repo();
  writeFileSync(join(root, "notes.txt"), "x\n");
  git(root, "add", "notes.txt");
  const before = text(root, "board/BOARD.md");
  const res = addW4(root, "--commit");
  assert.equal(res.exit, 2);
  assert.match(
    res.out,
    /notes\.txt is already staged; commit or unstage it first, or drop --commit/,
  );
  assert.equal(text(root, "board/BOARD.md"), before);
});

test("refuses a target file that is untracked, writing nothing", () => {
  const root = repo();
  git(root, "rm", "-q", "--cached", "board/TASKS.md");
  git(root, "commit", "-q", "-m", "untrack");
  const before = text(root, "board/BOARD.md");
  const res = addW4(root, "--commit");
  assert.equal(res.exit, 2);
  assert.match(res.out, /board\/TASKS\.md is not a tracked file at HEAD/);
  assert.equal(text(root, "board/BOARD.md"), before);
});

test("refuses an edit that needs uncommitted lines, naming the file, writing nothing", () => {
  const root = repo();
  const full = text(root, "board/BOARD.md");
  writeFileSync(join(root, "board/BOARD.md"), full.replace(/^\| W3 .*\n/m, ""));
  git(root, "commit", "-q", "-am", "board without W3");
  writeFileSync(join(root, "board/BOARD.md"), full); // the W3 row is uncommitted
  const before = head(root);
  const res = call(set, root, ["task", "W3", "note=Changed", "--apply", "--commit"]);
  assert.equal(res.exit, 2);
  assert.match(res.out, /board\/BOARD\.md: the edit needs lines that are not committed yet/);
  assert.match(res.out, /commit those first, or drop --commit/);
  assert.equal(text(root, "board/BOARD.md"), full);
  assert.equal(head(root), before);
});

test("a failing hook puts the index back, keeps the working-tree write and exits 2", () => {
  const root = repo();
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho no good >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const before = head(root);
  const res = addW4(root, "--commit");
  assert.equal(res.exit, 2);
  assert.match(res.out, /the working tree is written, but the commit failed/);
  assert.match(res.out, /the index is back at HEAD/);
  assert.equal(head(root), before);
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
  assert.match(text(root, "board/BOARD.md"), /\| W4 \| A1/);
});

// A side commit, as a cherry-pick source whose change main already has: the pick stops with an empty change.
function sideCommit(root, file) {
  git(root, "checkout", "-q", "-b", "side");
  writeFileSync(join(root, file), "x\n");
  git(root, "add", file);
  git(root, "commit", "-q", "-m", "side");
  const sha = head(root);
  git(root, "checkout", "-q", "-");
  return sha;
}

test("refuses while a cherry-pick waits for its commit (clean index), writing nothing", () => {
  const root = repo();
  const side = sideCommit(root, "x.txt");
  writeFileSync(join(root, "x.txt"), "x\n");
  git(root, "add", "x.txt");
  git(root, "commit", "-q", "-m", "main has x too");
  spawnSync("git", ["-C", root, "cherry-pick", side]); // stops: empty
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
  const before = [head(root), text(root, "board/BOARD.md")];
  const res = addW4(root, "--commit");
  assert.equal(res.exit, 2);
  assert.match(res.out, /git has CHERRY_PICK_HEAD in progress/);
  assert.deepEqual([head(root), text(root, "board/BOARD.md")], before);
});

test("refuses while a merge waits for its commit (clean index), writing nothing", () => {
  const root = repo();
  const side = sideCommit(root, "y.txt");
  writeFileSync(join(root, "z.txt"), "z\n"); // main moves on, so side is not an ancestor
  git(root, "add", "z.txt");
  git(root, "commit", "-q", "-m", "main moves");
  git(root, "cherry-pick", side);
  git(root, "merge", "-q", "-s", "ours", "--no-commit", "--no-ff", "side");
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
  const before = [head(root), text(root, "board/BOARD.md")];
  const res = call(set, root, ["task", "W3", "note=Changed", "--apply", "--commit"]);
  assert.equal(res.exit, 2);
  assert.match(res.out, /git has MERGE_HEAD in progress/);
  assert.deepEqual([head(root), text(root, "board/BOARD.md")], before);
});

test("refuses while a rebase is in progress, writing nothing", () => {
  const root = repo();
  mkdirSync(join(root, ".git", "rebase-merge"));
  const before = text(root, "board/BOARD.md");
  const res = addW4(root, "--commit");
  assert.equal(res.exit, 2);
  assert.match(res.out, /git has rebase-merge in progress/);
  assert.equal(text(root, "board/BOARD.md"), before);
});

// A running lane's ledger, as the lane CLI keeps it, owning `owned`.
function laneLedger(root, owned, state = "building") {
  const dir = join(root, ".agentry", "run", "process", "ledger");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "T1.json"),
    JSON.stringify({ v: 1, id: "T1", state, worktree: "/gone", owned }),
  );
}

test("refuses --commit when a running lane owns a target file; plain --apply still writes", () => {
  const root = repo();
  laneLedger(root, ["board/BOARD.md"]);
  const before = text(root, "board/BOARD.md");
  const res = addW4(root, "--commit");
  assert.equal(res.exit, 2);
  assert.match(res.out, /lane T1 is running and owns board\/BOARD\.md/);
  assert.match(res.out, /plain --apply/);
  assert.equal(text(root, "board/BOARD.md"), before);
  assert.equal(addW4(root).exit, 0);
});

test("a merged lane's owned files do not stop --commit", () => {
  const root = repo();
  laneLedger(root, ["board/BOARD.md"], "merged");
  assert.equal(addW4(root, "--commit").exit, 0);
});

test("when git cannot put the index back, the error says so instead of claiming it", () => {
  const root = repo();
  writeFileSync(join(root, ".git", "index.lock"), "");
  const res = addW4(root, "--commit");
  assert.equal(res.exit, 2);
  assert.match(res.out, /the index could not be put back/);
  assert.doesNotMatch(res.out, /the index is back at HEAD/);
});
