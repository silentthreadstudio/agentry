// Tests for the main guard's snapshot after `lane exec rebase` on temp git repos: the rebase
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
// The rebase round: the builder rebases onto main and reports; `during` runs on main while it is out.
function rebased(r, during = () => {}) {
  const out = lane(r, "rebase", "T1").json;
  assert.equal(out.next, "rebase");
  during();
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
  // The ledger an earlier `exec rebase` left: head moved, the board's start entry not.
  const r = repo();
  let out = lane(r, "start", "T1").json;
  commitBoard(r.root);
  const ledger = ledgerOf(r.root, "T1");
  const head = git(r.root, "rev-parse", "HEAD");
  const tip = git(r.root, "rev-parse", "agentry/T1");
  ledger.rebases = [
    { fromBase: ledger.base, fromTip: tip, mainHead: head, toBase: ledger.base, toTip: tip },
  ];
  ledger.mainAtStart.head = head;
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

test("with no rebase, the lane's own board row discarded on main still trips back to HEAD", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  git(r.root, "checkout", "--", BOARD);
  commitFile(out.worktree, "one.txt", "one\n", "feat: one");
  done(out, "added one.txt");
  const res = lane(r, "report", "T1");
  assert.equal(res.json.hold?.for, "guard", res.stderr);
  assert.match(res.json.guards[0], /plan\/BOARD\.md \(back to HEAD\)/);
});

test("a path dirty at start and discarded during the rebase round keeps its start and trips", () => {
  const r = repo();
  writeFileSync(join(r.root, "notes.txt"), "half\n");
  verified(r);
  const res = rebased(r, () => git(r.root, "checkout", "--", "notes.txt"));
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.hold?.for, "guard", JSON.stringify(res.json));
  assert.match(res.json.guards[0], /notes\.txt \(back to HEAD\)/);
  assert.ok(Object.hasOwn(ledgerOf(r.root, "T1").mainAtStart.files, "notes.txt"));
});

// The field shape: T2 cut at A, a commit X on main, the builder rebases the lane onto X in its
// worktree (`git rebase main`) and commits; the report runs the guard.
function rebasedInBranch(r, path, text = "by the conductor\n") {
  const out = lane(r, "start", "T2").json;
  const start = ledgerOf(r.root, "T2").mainAtStart.head;
  const x = commitFile(r.root, path, text, "chore: the conductor's commit");
  git(out.worktree, "rebase", "-q", "main");
  commitFile(out.worktree, "two.txt", "two\n", "feat: two");
  done(out, "added two.txt");
  return { out, start, x };
}

test("a lane rebased in-branch onto a main commit outside its files: the guard's start follows, no hold", () => {
  const r = repo();
  const { start, x } = rebasedInBranch(r, "notes.txt");
  const out = clear(lane(r, "report", "T2"), "the report");
  assert.equal(out.next, "verify");
  const ledger = ledgerOf(r.root, "T2");
  assert.equal(ledger.mainAtStart.head, x, "the start is the merge base");
  assert.deepEqual(
    ledger.startMoves.map(({ from, to, why }) => ({ from, to, why })),
    [{ from: start, to: x, why: "branch holds main" }],
  );
});

test("a main commit the branch holds that touches an owned file still trips, the start kept", () => {
  const r = repo();
  const { start, x } = rebasedInBranch(r, "two.txt", "a wrong-cwd edit\n");
  const res = lane(r, "report", "T2");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.hold?.for, "guard", JSON.stringify(res.json));
  assert.match(
    res.json.guards[0],
    new RegExp(`${x.slice(0, 7)} touches two\\.txt, this lane's files`),
  );
  const ledger = ledgerOf(r.root, "T2");
  assert.equal(ledger.mainAtStart.head, start);
  assert.equal(ledger.startMoves, undefined);
});

test("once the start followed the branch, a main commit after the merge base touching the lane's files trips", () => {
  const r = repo();
  const { x } = rebasedInBranch(r, "notes.txt");
  const y = commitFile(r.root, "two.txt", "on main after\n", "fix: two on main");
  const res = lane(r, "report", "T2");
  assert.equal(res.json.hold?.for, "guard", JSON.stringify(res.json));
  assert.match(
    res.json.guards[0],
    new RegExp(
      `HEAD moved ${x.slice(0, 7)} → ${y.slice(0, 7)} \\(${y.slice(0, 7)} touches two\\.txt`,
    ),
  );
  assert.equal(ledgerOf(r.root, "T2").mainAtStart.head, x, "the start moved to the merge base");
});

test("a start the branch moved counts as moved: the lane's own mid-write board entry is not back to HEAD", () => {
  // As the field-93 test above, with the move recorded in `startMoves` instead of `rebases`.
  const r = repo();
  let out = lane(r, "start", "T1").json;
  const from = ledgerOf(r.root, "T1").mainAtStart.head;
  commitBoard(r.root);
  const ledger = ledgerOf(r.root, "T1");
  const head = git(r.root, "rev-parse", "HEAD");
  ledger.startMoves = [{ from, to: head, why: "branch holds main", at: new Date().toISOString() }];
  ledger.mainAtStart.head = head;
  writeLedger(r.root, ledger);
  commitFile(out.worktree, "one.txt", "one\n", "feat: one");
  done(out, "added one.txt");
  out = clear(lane(r, "report", "T1"), "the report");
  assert.equal(out.next, "verify");
});
