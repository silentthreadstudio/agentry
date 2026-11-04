// Tests for the main guard's snapshot after `lane exec rebase` (field 93) on temp git repos: the rebase
// that moves `mainAtStart.head` refreshes the start entries of paths clean on main now and keeps those
// still dirty, and a path clean on main whose start entry is the lane's own board write is never "back to
// HEAD". Builders and verifiers are simulated by committing in the worktree and writing their report files.
// Run: node --test plugin/scripts/test/exec-guard.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitFile, git, gitEnv } from "./git-repo.mjs";
import { writeSpec } from "./spec-files.mjs";

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};

const SPEC = {
  version: 1,
  name: "Guard",
  root: "plan",
  kinds: {
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: { status: { column: "Status" }, verdict: { column: "Verdict" } },
      status: {
        field: "status",
        values: { todo: "planned", doing: "active", verify: "active", done: "done" },
      },
      contract: { blocks: ["TASKS.md"] },
    },
  },
  rules: [{ rule: "ids-unique" }],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", built: "verify", failed: "doing", merged: "done" },
    write: { status: "status", verdict: "verdict" },
  },
  gate: { tiers: [{ name: "full", command: ["sh", "-c", "true"] }] },
};
const BOARD_MD = `# Guard

## Tasks

| Task | Status | Verdict |
| ---- | ------ | ------- |
| T1   | todo   |         |
| T2   | todo   |         |
`;
// T1 owns the board too: a board file a running lane owns is guarded as any file is, so its start entry
// counts (else `guard.allow` lets the board through whatever its content).
const TASKS_MD = `# Tasks

- **T1**: owns \`one.txt\`, \`plan/BOARD.md\`. Accept: one.txt exists.
- **T2**: owns \`two.txt\`. Accept: two.txt exists.
`;
const BOARD = "plan/BOARD.md";

function repo() {
  const root = temp("exec-guard-repo-");
  const home = temp("exec-guard-home-");
  git(root, "init", "-q", "-b", "main");
  commitFile(root, ".gitignore", ".agentry/run/\n");
  commitFile(root, BOARD, BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  commitFile(root, "notes.txt", "notes\n");
  writeSpec(join(root, ".agentry"), SPEC);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
  return { root, home };
}
function lane(r, ...args) {
  const res = spawnSync("node", [LANE, "exec", ...args, "--json", "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home },
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {}
  return { exit: res.status, json, stderr: res.stderr };
}
const ledgerFile = (root, id) => join(root, ".agentry", "run", "process", "ledger", `${id}.json`);
const ledgerOf = (root, id) => JSON.parse(readFileSync(ledgerFile(root, id), "utf8"));
const writeLedger = (root, ledger) =>
  writeFileSync(ledgerFile(root, ledger.id), JSON.stringify(ledger, null, 2));
const done = (out, what) => writeFileSync(out.reportPath, `DONE\n${what}\nused_memories: none\n`);
// Not held by a guard: the report or resume went on.
function clear(res, what) {
  assert.equal(res.exit, 0, `${what}: ${res.stderr}`);
  assert.notEqual(res.json.hold?.for, "guard", `${what}: ${JSON.stringify(res.json.guards)}`);
  return res.json;
}

// T1 from start to a verified close; its start snapshot holds the board mid-write (its own `dispatched`).
function verified(r) {
  let out = lane(r, "start", "T1").json;
  commitFile(out.worktree, "one.txt", "one\n", "feat: one");
  done(out, "added one.txt");
  out = lane(r, "report", "T1").json;
  writeFileSync(out.reportPath, "Checked.\nused_memories: none\nVerdict: PASS\n");
  assert.equal(lane(r, "verdict", "T1").json.next, "gate");
  assert.equal(lane(r, "gate", "T1").exit, 0);
  assert.equal(lane(r, "close", "T1").exit, 0);
}
// The owner commits the board on main with an edit no lane recorded: main is clean at HEAD again.
function commitBoard(root) {
  const text = readFileSync(join(root, BOARD), "utf8");
  commitFile(root, BOARD, `${text}\nOne more line by hand.\n`, "chore: commit the board");
}
// The rebase round: the builder rebases onto main and reports.
function rebased(r) {
  const out = lane(r, "rebase", "T1").json;
  assert.equal(out.next, "rebase");
  git(out.worktree, "rebase", "-q", "main");
  done(out, "rebased onto main");
  return lane(r, "report", "T1");
}

test("the field shape: a rebase past a board commit refreshes the snapshot, and the report holds nothing", () => {
  const r = repo();
  verified(r);
  const own = ledgerOf(r.root, "T1");
  const dispatchedTo = own.boardWrites.find((m) => m.file === BOARD).to;
  assert.equal(own.mainAtStart.files[BOARD], dispatchedTo, "the start holds the board mid-write");
  commitBoard(r.root);
  const out = clear(rebased(r), "the rebase report");
  assert.ok(["gate", "resolve"].includes(out.next), out.next);
  const start = ledgerOf(r.root, "T1").mainAtStart;
  assert.equal(start.head, git(r.root, "rev-parse", "HEAD"));
  assert.equal(
    Object.hasOwn(start.files, BOARD),
    false,
    "a path clean on main is as HEAD holds it",
  );
  assert.deepEqual(start.porcelain, []);
});

test("a path still dirty on main after the rebase keeps its start: an edit made since still trips", () => {
  const r = repo();
  writeFileSync(join(r.root, "notes.txt"), "notes\nhalf an edit\n"); // dirty before the lane starts
  verified(r);
  commitBoard(r.root);
  writeFileSync(join(r.root, "notes.txt"), "notes\na stray edit\n");
  const res = rebased(r);
  assert.equal(res.exit, 0, res.stderr);
  assert.match(res.json.guards.join("\n"), /files changed: {2}M notes\.txt/);
  const start = ledgerOf(r.root, "T1").mainAtStart;
  assert.ok(Object.hasOwn(start.files, "notes.txt"), JSON.stringify(start));
  assert.deepEqual(start.porcelain, [" M notes.txt"]);
});

test("a ledger already rebased with the mid-write board in its snapshot reports and resumes with no guard hold", () => {
  // The ledger an earlier `exec rebase` left (field 93): head moved, the board's start entry not.
  const r = repo();
  let out = lane(r, "start", "T1").json;
  commitBoard(r.root);
  const ledger = ledgerOf(r.root, "T1");
  ledger.mainAtStart.head = git(r.root, "rev-parse", "HEAD");
  writeLedger(r.root, ledger);
  commitFile(out.worktree, "one.txt", "one\n", "feat: one");
  assert.equal(lane(r, "hold", "T1", "--for", "later").exit, 0);
  out = clear(lane(r, "resume", "T1", "--note", "go on"), "the resume");
  done(out, "added one.txt");
  assert.equal(clear(lane(r, "report", "T1"), "the report").next, "verify");
});

test("a path clean on main whose start is not the lane's own board write is still back to HEAD", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  commitBoard(r.root);
  const ledger = ledgerOf(r.root, "T1");
  ledger.mainAtStart.head = git(r.root, "rev-parse", "HEAD");
  ledger.mainAtStart.files[BOARD] = "0".repeat(40); // a start no write of this lane made
  writeLedger(r.root, ledger);
  commitFile(out.worktree, "one.txt", "one\n", "feat: one");
  done(out, "added one.txt");
  const res = lane(r, "report", "T1");
  assert.equal(res.json.hold?.for, "guard", res.stderr);
  assert.match(res.json.guards[0], /plan\/BOARD\.md \(back to HEAD\)/);
});
