// Tests for `lane merge` (plan R1b-5) on throwaway repositories with a synthetic board: the land (pick →
// gate or skip → record → board commit), its refusals and rollbacks, the repo checks, the push policy and
// the cleanup, each read through the step table and the repo's state afterwards.
// Run: node --test plugin/scripts/test/merge-cli.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { create } from "../lib/lane/worktree.mjs";
import { read as readLedger, write as writeLedger } from "../lib/process/ledger.mjs";
import { commitFile, git, gitEnv } from "./git-repo.mjs";
import { writeSpec } from "./spec-files.mjs";

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");
const ID = "T1";
const BRANCH = `agentry/${ID}`;

const SPEC = {
  version: 1,
  name: "Merge",
  root: "plan",
  kinds: {
    sprint: {
      label: "Sprint",
      at: { table: "BOARD.md", heading: "Sprints" },
      id: { column: "Sprint" },
      fields: { status: { column: "Status" } },
      status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
      file: {
        glob: "sprints/{id}.md",
        sections: { handoff: { heading: "Handoff", as: "bold-lead" } },
      },
    },
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: {
        sprint: { column: "Sprint", type: "ref", ref: "sprint", role: "parent" },
        status: { column: "Status" },
        verdict: { column: "Verdict" },
        commit: { column: "Commit", type: "commits" },
      },
      status: {
        field: "status",
        values: { todo: "planned", doing: "active", verify: "active", done: "done" },
      },
    },
  },
  rules: [
    { rule: "ids-unique" },
    { rule: "status-known" },
    { rule: "done-has-evidence", kind: "task", field: "commit", evidence: "commit" },
    { rule: "done-has-handoff", kind: "task", section: "handoff", commit: "first" },
  ],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", built: "verify", failed: "doing", merged: "done" },
    write: {
      status: "status",
      verdict: "verdict",
      commit: "commit",
      handoff: "parent.file:handoff",
    },
    handoff: "- **{id}** ({sha}): {summary}",
  },
  gate: {
    tiers: [
      { name: "docs", command: ["node", "gate.mjs", "docs"], when: { only: ["docs/**"] } },
      { name: "full", command: ["node", "gate.mjs", "full"] },
    ],
    after: ["docs/**"],
  },
};
const BOARD_MD = `# Merge

## Sprints

| Sprint | Status |
| ------ | ------ |
| S1     | doing  |

## Tasks

| Task | Sprint | Status | Verdict | Commit  |
| ---- | ------ | ------ | ------- | ------- |
| T1   | S1     | verify | PASS    |         |
| T2   | S1     | todo   |         |         |
`;
const SPRINT_MD = "# S1\n\n## Handoff\n\n## Notes\n\nNothing yet.\n";
// The fixture's gate: red when `red.txt` is in the tree, and it says which tier it ran. While the file
// $MERGE_TEST_HANG names exists, it runs until killed (a long gate the host kills the merge during).
const GATE_JS = `import { existsSync } from "node:fs";
console.log("gate tier", process.argv[2]);
const hang = process.env.MERGE_TEST_HANG;
if (hang && existsSync(hang)) setInterval(() => {}, 1000);
else process.exit(existsSync("red.txt") ? 1 : 0);
`;

let root;
let home;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "merge-home-")));
  root = realpathSync(mkdtempSync(join(tmpdir(), "merge-repo-")));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".agentry/run/\n");
  writeFileSync(join(root, "gate.mjs"), GATE_JS);
  mkdirSync(join(root, "plan", "sprints"), { recursive: true });
  writeFileSync(join(root, "plan", "BOARD.md"), BOARD_MD);
  writeFileSync(join(root, "plan", "sprints", "S1.md"), SPRINT_MD);
  setSpec(SPEC);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function setSpec(spec) {
  mkdirSync(join(root, ".agentry"), { recursive: true });
  writeSpec(join(root, ".agentry"), spec);
}
function commitSpec(spec) {
  setSpec(spec);
  git(root, "add", "-A", ".agentry");
  git(root, "commit", "-q", "-m", "spec");
}
const setPush = (push) => {
  mkdirSync(join(root, ".agentry"), { recursive: true });
  writeFileSync(join(root, ".agentry", "config.json"), JSON.stringify({ merge: { push } }));
  // config.json would dirty main: keep it out of the tree like a user's local config.
  writeFileSync(join(root, ".git", "info", "exclude"), ".agentry/config.json\n");
};

/** `lane merge <args>` against the fixture. */
const merge = (...args) =>
  spawnSync("node", [LANE, "merge", ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home, NO_COLOR: "1" },
  });
const out = (res) => res.stdout + res.stderr;
/** A land that must succeed, failing with its step table when it does not. */
function mustLand(...args) {
  const res = merge(ID, ...args, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  return res;
}
const head = () => git(root, "rev-parse", "HEAD");
const status = () => git(root, "status", "--porcelain", "--untracked-files=all");
const board = () => readFileSync(join(root, "plan", "BOARD.md"), "utf8");
const sprint = () => readFileSync(join(root, "plan", "sprints", "S1.md"), "utf8");
const boardCheck = () =>
  spawnSync("node", [join(dirname(LANE), "board.mjs"), "check", "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, NO_COLOR: "1" },
  });

/** The task's worktree and branch (as exec makes them), with `files` committed on it. */
function build(files) {
  const { path } = create(root, { id: ID, base: "main" });
  const shas = Object.entries(files).map(([file, text]) => commitFile(path, file, text));
  return { path, shas };
}

const FULL_CMD = ["node", "gate.mjs", "full"];
// An exec ledger for the branch, verified; `gated` adds a green worktree gate of the full tier on that
// commit, `record` changes that gate record (a tier, an argv, an exit, no command).
function execLedger({ path, gated, record = {} }) {
  writeLedger(root, {
    v: 1,
    id: ID,
    kind: "task",
    contract: { file: "plan/TASKS.md", line: 1 },
    origin: "exec",
    mainBranch: "main",
    base: git(root, "rev-parse", "main"),
    worktree: path,
    branch: BRANCH,
    mainAtStart: { head: git(root, "rev-parse", "main"), porcelain: [] },
    worktreesAtStart: [],
    rounds: [],
    gates: gated
      ? [
          {
            where: "worktree",
            role: "build",
            tier: "full",
            command: FULL_CMD,
            commit: gated,
            tree: git(root, "rev-parse", `${gated}^{tree}`),
            exit: 0,
            cleanBefore: true,
            cleanAfter: true,
            log: "/dev/null",
            seconds: 1,
            at: "2026-10-31T00:00:00.000Z",
            ...record,
          },
        ]
      : [],
    checks: {},
    usedMemories: [],
    state: "verified",
    next: "",
  });
}

test("--json prints the step table as rows and the next step, with any mode", () => {
  build({ "src/a.txt": "a\n" });
  const pf = merge(ID, "--branch", BRANCH, "--preflight", "--json");
  assert.equal(pf.status, 0, out(pf));
  const data = JSON.parse(pf.stdout);
  assert.equal(data.id, ID);
  assert.equal(data.branch, BRANCH);
  assert.ok(data.rows.some((r) => r.step === "commits" && r.mark === "ok"));
  assert.match(data.next, /^lane merge T1 --message/);
});

test("a branch not cut from main's tip is a warning row, not a green tick", () => {
  build({ "src/a.txt": "a\n" });
  commitFile(root, "src/z.txt", "z\n");
  const pf = merge(ID, "--branch", BRANCH, "--preflight");
  assert.equal(pf.status, 0, out(pf));
  assert.match(pf.stdout, /\n {2}! commits +1 to land\n(.*\n)*.*is not cut from main's tip/);
});

test("an adopted branch lands: picks, full gate, done + commit cell + handoff, one board commit", () => {
  build({ "src/a.txt": "a\n", "src/b.txt": "b\n" });
  const pre = head();
  const pf = merge(ID, "--branch", BRANCH, "--preflight");
  assert.equal(pf.status, 0, out(pf));
  assert.match(pf.stdout, /adopted agentry\/T1/);
  assert.match(pf.stdout, /2 to land/);
  assert.equal(readLedger(root, ID).origin, "adopted");

  const res = merge(ID, "--message", "docs(board): land T1", "--summary", "two files");
  assert.equal(res.status, 0, out(res));
  // The step table names each step, and the gate's tier and why.
  for (const step of ["ledger", "board", "checks", "main", "land", "gate", "record", "commit"])
    assert.match(res.stdout, new RegExp(`[✓·] ${step}`), step);
  assert.match(res.stdout, /full ran on main: exit 0/);
  assert.match(
    res.stdout,
    /full: no earlier tier's "when" holds \(docs: src\/a\.txt is outside its "only"\)/,
  );
  assert.match(res.stdout, /not skipped: no gate record/);

  // main: preHead → the two picks → the board commit, nothing else; clean.
  const chain = git(root, "rev-list", "--reverse", `${pre}..HEAD`).split("\n");
  assert.equal(chain.length, 3);
  assert.deepEqual(
    chain.slice(0, 2).map((sha) => git(root, "log", "-1", "--format=%s", sha)),
    ["add src/a.txt", "add src/b.txt"],
  );
  assert.equal(git(root, "log", "-1", "--format=%B").trim(), "docs(board): land T1");
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), [
    "plan/BOARD.md",
    "plan/sprints/S1.md",
  ]);
  assert.equal(status(), "");
  const [a, b] = chain.slice(0, 2).map((sha) => sha.slice(0, 7));
  assert.match(board(), new RegExp(`\\| T1 +\\| S1 +\\| done +\\| PASS +\\| ${a}…${b} +\\|`));
  assert.ok(sprint().includes(`- **T1** (${a}): two files\n`), sprint());
  const check = boardCheck();
  assert.equal(check.status, 0, check.stdout);
  assert.equal(readLedger(root, ID).state, "merged");
});

test("the gate is skipped only on a green worktree gate of the land's tier and argv whose tree is main's after the land", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, new RegExp(`skipped: gate on ${shas[0].slice(0, 7)}, tree identical`));
  assert.equal(readLedger(root, ID).gates.filter((g) => g.where === "main").length, 0);
});

test("a green record of a cheaper tier before a full land runs full, saying why", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({
    path,
    gated: shas[0],
    record: { tier: "docs", command: ["node", "gate.mjs", "docs"] },
  });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /full ran on main: exit 0/);
  assert.match(res.stdout, /not skipped: the recorded gate ran docs, the land needs full/);
  const ran = readLedger(root, ID).gates.at(-1);
  assert.deepEqual(
    [ran.where, ran.role, ran.tier, ran.command],
    ["main", "merge", "full", FULL_CMD],
  );
});

// A worktree record the land cannot trust, and the reason its gate row gives.
for (const [what, record, why] of [
  [
    "whose tier command was edited since",
    { command: ["node", "gate.mjs", "full", "--old"] },
    /not skipped: the full tier's command changed since the gate ran/,
  ],
  ["that is red", { exit: 1 }, /not skipped: the recorded gate exited 1/],
  [
    "from before tiers",
    { command: undefined },
    /not skipped: the recorded gate \(full tier\) has no command/,
  ],
  [
    "of the old quick tier",
    { tier: "quick", command: undefined },
    /not skipped: the recorded gate \(quick tier\) has no command/,
  ],
])
  test(`a worktree record ${what} never lets the land skip`, () => {
    const { path, shas } = build({ "src/a.txt": "a\n" });
    execLedger({ path, gated: shas[0], record });
    const res = merge(ID, "--message", "docs(board): land T1");
    assert.equal(res.status, 0, out(res));
    assert.match(res.stdout, /full ran on main: exit 0/);
    assert.match(res.stdout, why);
  });

test("a post-gate docs commit inside `after` still skips, and the table names the glob it matched", () => {
  const { path, shas } = build({ "src/a.txt": "a\n", "docs/notes.md": "later\n" });
  execLedger({ path, gated: shas[0] });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /skipped: gate on/);
  assert.match(res.stdout, /docs\/notes\.md matched after "docs\/\*\*"/);
});

test("a post-gate commit outside `after` forces the gate", () => {
  const { path, shas } = build({ "src/a.txt": "a\n", "src/late.txt": "late\n" });
  execLedger({ path, gated: shas[0] });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /full ran on main: exit 0/);
  assert.match(
    res.stdout,
    /not skipped: src\/late\.txt changed since the gate and is not in "after"/,
  );
});

test("the gate is not skipped when main moved, so main's tree is not the branch tip's", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  commitFile(root, "other.txt", "main moved\n");
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /not skipped: main's tree differs from the branch tip's tree/);
});

/** An episode the conductor's memory write left untracked on main (a repo that commits `.agentry/`). */
const writeEpisode = () => {
  const dir = join(root, ".agentry", "memory", "episodes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "built-01ARZ3NDEKTSV4RRFFQ69G5FAV.md"), "an episode\n");
};

test("main moved before the land and an uncommitted episode is on it: the gate runs on main and the land completes", () => {
  build({ "src/a.txt": "a\n" });
  commitFile(root, "other.txt", "main moved\n");
  writeEpisode();
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /full ran on main: exit 0/);
  assert.equal(status(), "?? .agentry/memory/episodes/built-01ARZ3NDEKTSV4RRFFQ69G5FAV.md");
});

test("a recorded worktree gate is not trusted after main moved, and an episode on main does not stop the re-gate", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  commitFile(root, "other.txt", "main moved\n");
  writeEpisode();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /full ran on main: exit 0/);
  assert.equal(readLedger(root, ID).state, "merged");
});

test("a docs-only change runs the docs tier and says why", () => {
  build({ "docs/guide.md": "words\n" });
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /docs ran on main: exit 0/);
  assert.match(res.stdout, /docs: every changed file \(1\) matches its "only"/);
  const ran = readLedger(root, ID).gates.at(-1);
  assert.deepEqual(
    [ran.role, ran.tier, ran.command],
    ["merge", "docs", ["node", "gate.mjs", "docs"]],
  );
  assert.match(readFileSync(ran.log, "utf8"), /gate tier docs/);
});

test("merge: full runs the last tier on a docs-only change", () => {
  commitSpec({ ...SPEC, gate: { ...SPEC.gate, roles: { merge: "full" } } });
  build({ "docs/guide.md": "words\n" });
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /full ran on main: exit 0/);
  assert.match(res.stdout, /full: gate\.roles\.merge is "full"/);
});

test("the land's gate on main runs behind the gate lock, taking over an old empty lock file", () => {
  build({ "src/a.txt": "a\n" });
  const dir = join(root, ".agentry", "run", "gate-locks");
  mkdirSync(dir, { recursive: true });
  const stale = join(dir, "slot-1.lock");
  writeFileSync(stale, "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(stale, old, old);
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /full ran on main: exit 0/);
  assert.equal(existsSync(stale), false, "the lock is released after the gate");
});

test("a red gate rolls main back to preHead and writes nothing to the board", () => {
  build({ "red.txt": "fails the gate\n" });
  const pre = head();
  const before = board();
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ gate +full ran on main: exit 1/);
  assert.match(res.stdout, /✓ rollback main reset to/);
  assert.equal(head(), pre);
  assert.equal(status(), "");
  assert.equal(board(), before);
  const ledger = readLedger(root, ID);
  assert.equal(ledger.merge.step, "rolled-back");
  assert.equal(ledger.gates.at(-1).exit, 1);
});

test("after a rollback an exec lane is back in the state it landed from, so its fix round can run", () => {
  const { path } = build({ "red.txt": "fails the gate\n" });
  execLedger({ path, gated: null });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.equal(readLedger(root, ID).state, "verified");
});

/** Another task's lane, open (exec is building it): its lifecycle writes may wait on main. */
const openLane = (id, state = "building") =>
  writeLedger(root, {
    v: 1,
    id,
    kind: "task",
    origin: "exec",
    mainBranch: "main",
    branch: `agentry/${id}`,
    rounds: [],
    gates: [],
    checks: {},
    usedMemories: [],
    state,
    next: "",
  });
// Exec writes T2's status cell through the lifecycle (T2's lane is open) and leaves it uncommitted.
const T2_DOING = ["| T2   | S1     | todo   |", "| T2   | S1     | doing  |"];
const execWrites = () => {
  openLane("T2");
  writeFileSync(join(root, "plan", "BOARD.md"), board().replace(...T2_DOING));
};

test("exec's uncommitted board writes are carried into the board commit; main ends clean", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  execWrites();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /clean but for exec's uncommitted lifecycle writes/);
  assert.match(res.stdout, /T2 status: "todo" → "doing" \(plan\/BOARD\.md\)/);
  assert.match(res.stdout, /✓ carry +1 board file\(s\) set aside, recorded in the ledger first/);
  assert.equal(status(), "");
  const committed = git(root, "show", "HEAD:plan/BOARD.md");
  assert.match(committed, /\| T2 +\| S1 +\| doing +\|/); // exec's write
  assert.match(committed, /\| T1 +\| S1 +\| done +\|/); // the merged write
  assert.equal(boardCheck().status, 0);
  assert.equal(readLedger(root, ID).merge.carry, undefined); // in the commit: the ledger let go
});

test("with exec's board writes on main, any other change still refuses the land", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  execWrites();
  writeFileSync(join(root, "plan", "sprints", "S1.md"), `${sprint()}\nhand edit\n`);
  const pre = head();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /1 uncommitted change\(s\) the land cannot carry/);
  assert.match(out(res), /plan\/sprints\/S1\.md:\d+: lines added or removed/);
  assert.match(
    out(res),
    /only lifecycle cells \(status, verdict, commit\) of tasks with an open lane/,
  );
  assert.equal(head(), pre);
});

// R1b-5 fix 1 (and R1b-4 re-verify item 1): the carry took whole board files, so a builder's stray edit
// in BOARD.md rode into another lane's board commit.
test("a stray edit in the board file next to exec's write blocks the land and is never committed", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  execWrites();
  const pre = head();
  for (const stray of [
    ["## Tasks\n", "## Tasks\n\nSneaked in by a builder.\n"], // free text
    ["| S1     | doing  |", "| S1     | done   |"], // another row's cell
  ]) {
    writeFileSync(join(root, "plan", "BOARD.md"), BOARD_MD.replace(...T2_DOING).replace(...stray));
    const res = merge(ID, "--message", "docs(board): land T1");
    assert.equal(res.status, 2, out(res));
    assert.match(out(res), /the land cannot carry/);
    assert.equal(head(), pre);
    assert.doesNotMatch(git(root, "log", "-p", "--format=", `${pre}..HEAD`), /Sneaked|done/);
  }
  assert.match(
    out(merge(ID, "--message", "docs(board): land T1")),
    /sprint S1 status "doing" → "done" is not a lifecycle cell/,
  );
});

test("a lifecycle cell of a task with no open lane is not carried", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  writeFileSync(join(root, "plan", "BOARD.md"), board().replace(...T2_DOING));
  openLane("T2", "merged");
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /task T2 status "todo" → "doing", but T2 has no open lane/);
});

// R1b-5 re-verify item 5: the board check's baseline was read with the carry already back on the
// board, so a finding the carry itself brought passed and was committed.
test("a new finding brought by exec's carried write stops the land; nothing of it is committed", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  openLane("T2");
  writeFileSync(
    join(root, "plan", "BOARD.md"),
    board().replace(T2_DOING[0], "| T2   | S1     | bogus  |"),
  );
  const dirty = board();
  const pre = head();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ record +board check: 1 new finding\(s\)/);
  assert.match(res.stdout, /status-known T2/);
  assert.doesNotMatch(git(root, "log", "-p", "--format=", `${pre}..HEAD`), /bogus/);
  assert.equal(board(), dirty); // exec's write is back on main, uncommitted
});

test("a red gate gives main back exec's uncommitted board writes as they were", () => {
  const { path } = build({ "red.txt": "fails the gate\n" });
  execLedger({ path, gated: null });
  execWrites();
  const dirty = board();
  const pre = head();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✓ rollback/);
  assert.match(res.stdout, /✓ carry +exec's board writes are on main again, uncommitted/);
  assert.equal(head(), pre);
  assert.equal(board(), dirty);
  assert.equal(status(), "M plan/BOARD.md");
  assert.equal(readLedger(root, ID).merge.carry, undefined);
});

// R1b-5 notes item 1: the carry went back as a text patch with three lines of context, so another lane's
// exec write on the next row, made while the gate ran on main, broke it ("patch failed") and the plain
// rerun the table promised stopped on --drop-carry. Parallel lanes in one sprint do exactly that.
test("another lane's exec write next to the carry during the gate: the carry goes back and the rerun lands", () => {
  commitFile(
    root,
    "plan/BOARD.md",
    `${BOARD_MD}| T3   | S1     | todo   |         |         |\n`,
    "add T3",
  );
  // The gate stands in for `lane exec start T3` on main while it runs: T3's status cell, once.
  commitFile(
    root,
    "gate.mjs",
    `import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const once = \`\${process.env.HOME}/t3-starts\`;
if (existsSync(once)) {
  rmSync(once);
  const board = readFileSync("plan/BOARD.md", "utf8");
  writeFileSync("plan/BOARD.md", board.replace("| T3   | S1     | todo   |", "| T3   | S1     | doing  |"));
}
`,
  );
  const { path } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: null });
  openLane("T3");
  execWrites();
  writeFileSync(join(home, "t3-starts"), "");
  const first = merge(ID, "--message", "docs(board): land T1");
  assert.equal(first.status, 1, out(first));
  assert.match(first.stdout, /✗ rollback main is not clean/);
  assert.match(first.stdout, /✓ carry +exec's board writes are on main again, uncommitted/);
  assert.match(board(), /\| T2 +\| S1 +\| doing +\|/);
  assert.match(board(), /\| T3 +\| S1 +\| doing +\|/);
  assert.equal(readLedger(root, ID).merge.carry, undefined);
  assert.match(first.stdout, /next: .*run the same land again/);

  const again = merge(ID, "--message", "docs(board): land T1");
  assert.equal(again.status, 0, out(again));
  const committed = git(root, "show", "HEAD:plan/BOARD.md");
  assert.match(committed, /\| T1 +\| S1 +\| done +\|/);
  assert.match(committed, /\| T2 +\| S1 +\| doing +\|/);
  assert.match(committed, /\| T3 +\| S1 +\| doing +\|/);
  assert.equal(status(), "");
});

// R1b-4 re-verify item 5: on a one-file-per-item board, another lane's lifecycle write in its own item
// file blocked every land ("main is not clean").
test("on a one-file-per-item board, an open lane's write in its own file is carried", () => {
  const stories = {
    version: 1,
    name: "Files",
    root: ".",
    kinds: {
      story: {
        label: "Story",
        at: { files: "stories/*.md", id: "frontmatter:id" },
        fields: { state: { column: "state" }, commit: { column: "commit", type: "commits" } },
        status: { field: "state", values: { open: "planned", verify: "active", done: "done" } },
      },
    },
    rules: [],
    lifecycle: {
      kind: "story",
      on: { dispatched: "verify", merged: "done" },
      write: { status: "state", commit: "commit" },
    },
    gate: SPEC.gate,
  };
  commitFile(root, "stories/s1.md", "---\nid: S-1\nstate: open\ncommit:\n---\n\n# One\n");
  commitFile(root, "stories/s2.md", "---\nid: S-2\nstate: verify\ncommit:\n---\n\n# Two\n");
  commitSpec(stories);
  openLane("S-1");
  const s1 = join(root, "stories", "s1.md");
  writeFileSync(s1, readFileSync(s1, "utf8").replace("state: open", "state: verify"));
  const { path } = create(root, { id: "S-2", base: "main" });
  commitFile(path, "src/b.txt", "b\n");
  const res = merge("S-2", "--branch", "agentry/S-2", "--message", "docs(board): land S-2");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /S-1 state: "open" → "verify" \(stories\/s1\.md\)/);
  assert.equal(status(), "");
  assert.match(git(root, "show", "HEAD:stories/s1.md"), /state: verify/);
  assert.match(git(root, "show", "HEAD:stories/s2.md"), /state: done/);
});

test("a stop whose give-back conflicts names --drop-carry, not 'run the same land again'", () => {
  // The gate changes the carried cell itself (T2 todo -> verify on main) and fails: the rollback is
  // refused on the dirty tree, and the carry cannot go back over the changed cell.
  commitFile(
    root,
    "gate.mjs",
    `import { readFileSync, writeFileSync } from "node:fs";
const board = readFileSync("plan/BOARD.md", "utf8");
writeFileSync("plan/BOARD.md", board.replace("| T2   | S1     | todo   |", "| T2   | S1     | verify |"));
process.exit(1);
`,
  );
  const { path } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: null });
  execWrites();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ carry +exec's board writes no longer apply to plan\/BOARD\.md/);
  assert.match(res.stdout, /next: .*--drop-carry/);
  assert.doesNotMatch(res.stdout, /next: .*run the same land again/);
});

test("a carry recorded without cells (an older version) says so and points at --drop-carry", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  commitFile(path, "plan/BOARD.md", BOARD_MD.replace(T2_DOING[0], "| T2   | S1     | verify |"));
  execLedger({ path, gated: shas[0] });
  execWrites();
  merge(ID, "--message", "docs(board): land T1");
  const ledger = readLedger(root, ID);
  const { cells, cellsSha256, ...old } = ledger.merge.carry;
  writeLedger(root, { ...ledger, merge: { ...ledger.merge, carry: old } });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(
    res.stdout,
    /recorded by an older version; rerun with --drop-carry \(the patch is kept\)/,
  );
  assert.doesNotMatch(res.stdout, /the ledger was edited/);
});

test("--drop-carry with nothing set aside is refused", () => {
  build({ "src/a.txt": "a\n" });
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1", "--drop-carry");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /--drop-carry: the ledger holds no set-aside board writes/);
});

// R1b-5 fix 5: a carry that no longer applies used to be dropped on the next run, silently. The carry
// goes back cell by cell, so only a carried cell that itself changed is in the way (R1b-5 notes item 1).
test("a carried cell changed under the land blocks every rerun until --drop-carry, which keeps its patch", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  commitFile(path, "plan/BOARD.md", BOARD_MD.replace(T2_DOING[0], "| T2   | S1     | verify |"));
  execLedger({ path, gated: shas[0] });
  execWrites();
  const first = merge(ID, "--message", "docs(board): land T1");
  assert.equal(first.status, 1, out(first));
  assert.match(first.stdout, /✗ record +exec's board writes do not apply on top of the picks/);
  assert.match(first.stdout, /T2 status: "todo" → "doing" \(plan\/BOARD\.md\): it reads "verify"/);
  assert.match(first.stdout, /they stay in the ledger \(merge\.carry/);
  assert.ok(readLedger(root, ID).merge.carry);

  const second = merge(ID, "--message", "docs(board): land T1");
  assert.equal(second.status, 1, out(second));
  assert.match(second.stdout, /✗ carry +exec's board writes no longer apply to plan\/BOARD\.md/);
  assert.match(second.stdout, /next: .*--drop-carry/);
  assert.equal(readLedger(root, ID).state, "merging");

  const dropped = merge(ID, "--message", "docs(board): land T1", "--drop-carry");
  assert.equal(dropped.status, 0, out(dropped));
  assert.match(dropped.stdout, /dropped exec's board writes \(the owner's --drop-carry\)/);
  const [record] = readLedger(root, ID).merge.droppedCarries;
  assert.match(readFileSync(record.patchFile, "utf8"), /^\+\| T2 +\| S1 +\| doing/m);
  assert.equal(readLedger(root, ID).state, "merged");
  assert.equal(status(), "");
});

// --- a killed land and its rerun ------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gatePidFile = () => join(root, ".agentry", "run", "process", "runs", ID, "merge-gate-1.pid");
const gateGroup = () => {
  try {
    return Number(readFileSync(gatePidFile(), "utf8")) || null;
  } catch {
    return null;
  }
};
const alive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Start the land in the background and SIGKILL it (as a host's time limit does) once its gate runs. */
async function killDuringGate() {
  const hang = join(home, "hang");
  writeFileSync(hang, "");
  const args = [LANE, "merge", ID, "--message", "docs(board): land T1", "--root", root];
  const env = { ...gitEnv, HOME: home, NO_COLOR: "1", MERGE_TEST_HANG: hang };
  const child = spawn("node", args, { env, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const log = join(root, ".agentry", "run", "process", "runs", ID, "merge-gate-1.log");
  const started = () => existsSync(log) && readFileSync(log, "utf8").includes("gate tier");
  for (let i = 0; i < 500 && !started(); i++) await sleep(20);
  assert.ok(started(), "the gate never started");
  child.kill("SIGKILL");
  await exited;
  rmSync(hang);
  return gateGroup();
}
const endGroup = (pgid) => {
  if (pgid && alive(pgid)) process.kill(-pgid, "SIGKILL");
};

// A git on PATH in front of the real one: at the first call whose argv matches $KILL_ON it SIGKILLs its
// parent, `lane merge`, before or after running that call (a host's time limit landing right there).
const REAL_GIT = process.env.PATH.split(":")
  .map((dir) => join(dir, "git"))
  .find((file) => existsSync(file));
function killShim() {
  const dir = join(home, "shim");
  mkdirSync(dir, { recursive: true });
  const shim = `#!/bin/bash
if [ -f "$KILL_MARK" ] && [[ "$*" =~ $KILL_ON ]]; then
  rm -f "$KILL_MARK"
  if [ "$KILL_WHEN" = after ]; then "${REAL_GIT}" "$@"; st=$?; kill -9 $PPID; exit $st; fi
  kill -9 $PPID; exit 137
fi
exec "${REAL_GIT}" "$@"
`;
  writeFileSync(join(dir, "git"), shim);
  chmodSync(join(dir, "git"), 0o755);
  return dir;
}
/** The land, killed at the first git call matching `on` (a regex over its argv), `when` before|after. */
function landKilledAt(on, when, ...args) {
  const mark = join(home, "kill.mark");
  writeFileSync(mark, "");
  const env = {
    ...gitEnv,
    HOME: home,
    NO_COLOR: "1",
    PATH: `${killShim()}:${process.env.PATH}`,
    KILL_MARK: mark,
    KILL_ON: on,
    KILL_WHEN: when,
  };
  const argv = [LANE, "merge", ID, "--message", "docs(board): land T1", ...args, "--root", root];
  const res = spawnSync("node", argv, { encoding: "utf8", env });
  assert.equal(res.signal, "SIGKILL", `the land was not killed at ${on}:\n${out(res)}`);
  return res;
}
/** main's first-parent commits since `from`, oldest first. */
const chainSince = (from) =>
  git(root, "rev-list", "--first-parent", "--reverse", `${from}..HEAD`).split("\n").filter(Boolean);
/** What git keeps while a cherry-pick is in progress, of what main's .git holds. */
const pickInProgressFiles = () =>
  ["sequencer", "CHERRY_PICK_HEAD"].filter((name) => existsSync(join(root, ".git", name)));

// R1b-5 re-verify item 1: a land killed after its board commit, before the ledger said so, stuck: every
// rerun was red ("carry no longer applies", then "main has moved"), the ledger left at `merging`.
test("a land killed right after its board commit is finished by the rerun, not redone", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  execWrites();
  const pre = head();
  landKilledAt("^-C [^ ]+ commit --quiet -m", "after");
  const committed = head();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /✓ recover +a killed run had made the board commit/);
  assert.equal(head(), committed); // nothing picked or committed again
  assert.equal(chainSince(pre).length, 2);
  const ledger = readLedger(root, ID);
  assert.equal(ledger.state, "merged");
  assert.equal(ledger.merge.boardCommit, committed);
  assert.equal(ledger.merge.carry, undefined);
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T2 +\| S1 +\| doing +\|/);
  assert.equal(status(), "");
});

// R1b-5 re-verify item 2: a land killed after its board writes, before the commit (a slow pre-commit
// hook), left them staged on main, and no rerun got past them.
test("a land killed with its board writes staged takes them back on the rerun and lands", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  execWrites();
  const pre = head();
  landKilledAt("^-C [^ ]+ commit --quiet -m", "before");
  assert.match(status(), /^M {2}plan\/BOARD\.md$/m); // the writes, staged
  // /agentry:merge starts with the preflight: it must point at the land, not at a hand clean-up.
  const pf = merge(ID, "--preflight");
  assert.equal(pf.status, 0, out(pf));
  assert.match(pf.stdout, /✓ recover +a killed land was writing the board: the land clears it/);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /✓ recover +took back the board writes a killed run left uncommitted/);
  assert.equal(chainSince(pre).length, 2); // the pick and one board commit
  const committed = git(root, "show", "HEAD:plan/BOARD.md");
  assert.match(committed, /\| T1 +\| S1 +\| done +\|/);
  assert.match(committed, /\| T2 +\| S1 +\| doing +\|/); // exec's write, carried once
  assert.equal(git(root, "show", "HEAD:plan/sprints/S1.md").match(/- \*\*T1\*\*/g).length, 1);
  assert.equal(status(), "");
  assert.equal(readLedger(root, ID).state, "merged");
});

// R1b-5 re-verify item 3: a red gate's rollback killed after the reset, before the ledger said so: the
// rerun read main at preHead as "main has moved", and the lane stayed `merging`.
test("a rollback killed after its reset is finished by the rerun: lane back, exec's writes back", () => {
  const { path } = build({ "red.txt": "fails the gate\n" });
  execLedger({ path, gated: null });
  execWrites();
  const dirty = board();
  const pre = head();
  landKilledAt("^-C [^ ]+ reset --keep", "after");
  assert.equal(head(), pre);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(
    res.stdout,
    /✓ recover +finishing the rollback a killed run started after its red gate/,
  );
  assert.match(res.stdout, /✓ rollback main reset to/);
  assert.match(res.stdout, /next: read .*merge-gate-1\.log, fix on agentry\/T1/);
  const ledger = readLedger(root, ID);
  assert.equal(ledger.state, "verified");
  assert.equal(ledger.merge.step, "rolled-back");
  assert.equal(ledger.merge.carry, undefined);
  assert.equal(head(), pre);
  assert.equal(board(), dirty); // exec's writes, uncommitted, as they were
  assert.equal(ledger.gates.filter((g) => g.where === "main").length, 1); // no second gate run
});

// R1b-5 re-verify item 6: with the carry recorded but still on main's tree (killed before it was set
// aside), --drop-carry said "dropped", then took the same edits as a new carry and committed them.
test("--drop-carry of a carry still on main's tree takes it off, so it is not committed", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  execWrites();
  landKilledAt("^-C [^ ]+ --literal-pathspecs restore --source=HEAD", "before");
  assert.ok(readLedger(root, ID).merge.carry);
  assert.equal(status(), "M plan/BOARD.md"); // still on the tree
  const res = merge(ID, "--message", "docs(board): land T1", "--drop-carry");
  assert.equal(res.status, 0, out(res));
  assert.match(
    res.stdout,
    /dropped exec's board writes \(the owner's --drop-carry\), off main too/,
  );
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T2 +\| S1 +\| todo +\|/);
  assert.equal(status(), "");
  const [record] = readLedger(root, ID).merge.droppedCarries;
  assert.match(readFileSync(record.patchFile, "utf8"), /^\+\| T2 +\| S1 +\| doing/m);
});

// R1b-5 fix 2: a killed land set exec's writes aside in a patch file only; the rerun saw a clean main
// and landed without them.
test("a land killed during its gate keeps exec's writes in the ledger; the rerun commits them", async () => {
  const { path } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: null });
  execWrites();
  const pgid = await killDuringGate();
  try {
    const { carry } = readLedger(root, ID).merge;
    assert.deepEqual(carry.files, ["plan/BOARD.md"]);
    assert.equal(carry.sha256, createHash("sha256").update(carry.patch).digest("hex"));
    assert.match(carry.patch, /^\+\| T2 +\| S1 +\| doing/m);
    assert.equal(status(), ""); // set aside: the gate ran on a clean tree
    const res = merge(ID, "--message", "docs(board): land T1");
    assert.equal(res.status, 0, out(res));
    assert.match(res.stdout, /exec's board writes are on main again/);
    assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T2 +\| S1 +\| doing +\|/);
    assert.equal(status(), "");
  } finally {
    endGroup(pgid);
  }
});

// R1b-5 fix 6: the gate of a killed land kept running, in its own process group, on main's tree.
test("a rerun stops the gate a killed land left running, then gates again", async () => {
  const { path } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: null });
  const pgid = await killDuringGate();
  try {
    assert.ok(pgid && alive(pgid), "the killed land's gate is still running");
    assert.equal(readLedger(root, ID).merge.step, "gating");
    const res = merge(ID, "--message", "docs(board): land T1");
    assert.equal(res.status, 0, out(res));
    assert.match(
      res.stdout,
      new RegExp(
        `✓ recover +stopped the gate a killed run left running \\(process group ${pgid}\\)`,
      ),
    );
    assert.equal(alive(pgid), false);
    const ledger = readLedger(root, ID);
    assert.equal(ledger.merge.gateRun, undefined);
    const mainGates = ledger.gates.filter((g) => g.where === "main");
    assert.equal(mainGates.length, 1); // the rerun's gate
    // R1b-5 re-verify item 9: the rerun's gate wrote over the killed gate's log.
    const killedLog = join(dirname(gatePidFile()), "merge-gate-1.log");
    assert.match(readFileSync(killedLog, "utf8"), /gate tier/);
    assert.notEqual(mainGates[0].log, killedLog);
  } finally {
    endGroup(pgid);
  }
});

/** The ledger as a land killed while picking leaves it: the intent written, the picks not recorded. */
function killedWhilePicking(shas) {
  execLedger({ path: join(root, ".agentry", "run", "worktrees", ID), gated: null });
  const merge = { preHead: head(), planned: shas, landed: [], tip: shas.at(-1) };
  writeLedger(root, {
    ...readLedger(root, ID),
    state: "merging",
    merge: { ...merge, stateBefore: "verified", step: "picking", at: "2026-10-31T00:00:00Z" },
  });
}

// R1b-5 fix 3: picks a killed run made were not read back from main, so the rerun found nothing to land
// (or recorded the wrong commits).
test("a land killed after its picks reads them back from main and does not pick twice", () => {
  const { shas } = build({ "src/a.txt": "a\n", "src/b.txt": "b\n" });
  killedWhilePicking(shas);
  const pre = head();
  git(root, "cherry-pick", ...shas); // the picks the killed run made
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /2 commit\(s\) a killed run had picked onto/);
  const chain = git(root, "rev-list", "--first-parent", "--reverse", `${pre}..HEAD`).split("\n");
  assert.equal(chain.length, 3); // the two picks and the board commit, nothing picked twice
  assert.deepEqual(readLedger(root, ID).merge.landed, chain.slice(0, 2));
});

test("a land killed between its picks takes off the partial picks and picks them all again", () => {
  const { shas } = build({ "src/a.txt": "a\n", "src/b.txt": "b\n" });
  killedWhilePicking(shas);
  const pre = head();
  git(root, "cherry-pick", shas[0]);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /took off the 1 pick\(s\) a killed run made/);
  const chain = git(root, "rev-list", "--first-parent", "--reverse", `${pre}..HEAD`).split("\n");
  assert.equal(chain.length, 3);
  assert.deepEqual(readLedger(root, ID).merge.landed, chain.slice(0, 2));
});

test("a rerun aborts the cherry-pick its killed land left midway, and picks again from preHead", () => {
  const { shas } = build({ "src/ok.txt": "fine\n", "src/c.txt": "branch side\n" });
  commitFile(root, "src/c.txt", "main side\n");
  killedWhilePicking(shas);
  const pre = head();
  spawnSync("git", ["-C", root, "cherry-pick", ...shas], { env: gitEnv }); // stops on the conflict
  const again = merge(ID, "--message", "docs(board): land T1");
  assert.equal(again.status, 1, out(again));
  assert.match(again.stdout, /✓ recover +aborted the cherry-pick a killed run left/);
  assert.match(again.stdout, /✗ land +cherry-pick stopped on/); // picked again, from preHead
  assert.equal(head(), pre);
  assert.equal(status(), "");
});

// R1b-5 re-verify item 7: killed in the post-commit hook of the first pick, git keeps a stale
// CHERRY_PICK_HEAD after one `cherry-pick --abort` and does not rewind; the printed recovery said the
// abort puts main back, and it took two.
test("a land killed after its first pick's commit lands on the rerun, with no abort by hand", () => {
  const { path } = build({ "src/a.txt": "a\n", "src/b.txt": "b\n" });
  execLedger({ path, gated: null });
  const once = join(home, "kill-once");
  writeFileSync(once, "");
  const hook = join(root, ".git", "hooks", "post-commit");
  writeFileSync(
    hook,
    `#!/bin/sh\n[ -f "${once}" ] || exit 0\nrm -f "${once}"\nkill -9 $PPID $(ps -o ppid= -p $PPID)\n`,
  );
  chmodSync(hook, 0o755);
  const pre = head();
  assert.equal(merge(ID, "--message", "docs(board): land T1").signal, "SIGKILL");
  assert.equal(chainSince(pre).length, 1); // the first pick, mid-sequence
  const pf = merge(ID, "--preflight");
  assert.equal(pf.status, 0, out(pf));
  assert.match(pf.stdout, /✓ recover +a killed land left a cherry-pick: the land clears it/);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /✓ recover +aborted the cherry-pick a killed run left/);
  assert.match(res.stdout, /took off the 1 pick\(s\) a killed run made/);
  assert.equal(chainSince(pre).length, 3); // two picks and the board commit, each once
  assert.deepEqual(pickInProgressFiles(), []);
  assert.equal(status(), "");
});

test("a cherry-pick that is not this land's stops the land, and says how to clear it", () => {
  const { path, shas } = build({ "src/c.txt": "branch side\n" });
  execLedger({ path, gated: null });
  commitFile(root, "src/c.txt", "main side\n");
  const pre = head();
  spawnSync("git", ["-C", root, "cherry-pick", shas[0]], { env: gitEnv }); // the owner's, by hand
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(
    res.stdout,
    /✗ recover +git is in the middle of a cherry-pick that is not this land's/,
  );
  assert.match(res.stdout, /next: in .*: finish or abort it/);
  assert.equal(head(), pre);
  assert.ok(existsSync(join(root, ".git", "CHERRY_PICK_HEAD")), "the owner's pick is left alone");
});

// --- a rerun acts only on what it can prove is its own --------------------------------------------

const KILL_AT_COMMIT = "^-C [^ ]+ commit --quiet -m";
const S2_MD = join("plan", "sprints", "S2.md");
/** A second sprint on the board, committed: a board file the land never writes. */
function addSprintS2() {
  writeFileSync(
    join(root, "plan", "BOARD.md"),
    board().replace("| S1     | doing  |", "| S1     | doing  |\n| S2     | todo   |"),
  );
  writeFileSync(join(root, S2_MD), "# S2\n\n## Handoff\n\n## Notes\n\nNothing yet.\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "s2");
}

// R1b-5 round 4 item 1: killed at recording, then a note in a board file the land never writes; the
// rerun put every dirty board file back to HEAD, and the note was gone.
test("a rerun after a kill at recording leaves alone a board file the land did not write", () => {
  addSprintS2();
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  landKilledAt(KILL_AT_COMMIT, "before");
  writeFileSync(join(root, S2_MD), `${readFileSync(join(root, S2_MD), "utf8")}\nOWNER'S NOTE\n`);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res)); // the note is not the land's to carry: main refuses it
  assert.match(out(res), /✓ recover +took back the board writes a killed run left uncommitted/);
  assert.match(out(res), /✗ main +main has 1 uncommitted change\(s\) the land cannot carry/);
  assert.match(readFileSync(join(root, S2_MD), "utf8"), /OWNER'S NOTE/);
  assert.equal(status(), "M plan/sprints/S2.md"); // the land's own writes taken back, the note kept
});

// R1b-5 round 4 item 1: an edit on top of the land's own board writes was restored away with them.
test("a rerun after a kill at recording stops on a board file it wrote that changed since", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  landKilledAt(KILL_AT_COMMIT, "before");
  writeFileSync(join(root, "plan", "BOARD.md"), `${board()}\nOWNER'S NOTE\n`);
  const left = status();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ recover +.*a file it wrote changed since\n +plan\/BOARD\.md: /);
  assert.match(
    res.stdout,
    /next: .*git restore --source=HEAD --staged --worktree -- plan\/BOARD\.md/,
  );
  assert.match(board(), /OWNER'S NOTE/);
  assert.equal(status(), left); // nothing written or taken back
  assert.equal(readLedger(root, ID).merge.step, "recording");
});

// R1b-5 notes item 2: an edit only staged did not show in `git diff HEAD` (the working copy), so the
// printed recovery ("save that edit, then git restore --staged --worktree") erased it unseen.
test("after a kill at recording, an edit only staged is named as staged and shown by the recovery", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  landKilledAt(KILL_AT_COMMIT, "before");
  const written = sprint();
  writeFileSync(join(root, "plan", "sprints", "S1.md"), `${written}\nSTAGED NOTE\n`);
  git(root, "add", "plan/sprints/S1.md");
  writeFileSync(join(root, "plan", "sprints", "S1.md"), written);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /plan\/sprints\/S1\.md: staged holds neither HEAD's text/);
  assert.match(res.stdout, /next: .*git diff --cached HEAD -- plan\/sprints\/S1\.md \(staged\)/);
  assert.match(git(root, "show", ":plan/sprints/S1.md"), /STAGED NOTE/);
});

// R1b-5 notes item 6: the preflight's board row read the land's own writes from the working copy and
// said the task was "done" already.
test("after a kill at recording the preflight reads the task as committed", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  landKilledAt(KILL_AT_COMMIT, "before");
  assert.match(board(), /\| T1 +\| S1 +\| done +\|/);
  const pf = merge(ID, "--preflight");
  assert.equal(pf.status, 0, out(pf));
  assert.match(pf.stdout, /✓ board +task T1 is "verify" as committed; landing makes it "done"/);
});

// R1b-5 notes item 3: killed at recording, then the owner commits only an episode: the rerun took that
// commit for a foreign board commit ("it also changes .agentry/memory/…") and gave no way on.
test("after a kill at recording, a commit of only a memory record does not stop the rerun", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  const pre = head();
  landKilledAt(KILL_AT_COMMIT, "before");
  writeEpisode();
  const episode = ".agentry/memory/episodes/built-01ARZ3NDEKTSV4RRFFQ69G5FAV.md";
  git(root, "add", episode);
  git(root, "commit", "-q", "-m", "chore(memory): record the episode", "--", episode);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /✓ recover +took back the board writes a killed run left uncommitted/);
  const subjects = chainSince(pre).map((sha) => git(root, "log", "-1", "--format=%s", sha));
  assert.deepEqual(subjects, [
    "add src/a.txt",
    "chore(memory): record the episode",
    "docs(board): land T1",
  ]);
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T1 +\| S1 +\| done +\|/);
  assert.equal(status(), "");
});

// R1b-5 round 4 item 2: a board-only commit someone else made on the picks was taken for the land's
// board commit: the land was "done", T1 never written, exec's carried writes erased.
test("a board-only commit on the picks that is not the land's stops it; the carry is kept", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  execWrites();
  landKilledAt(KILL_AT_COMMIT, "before");
  git(root, "restore", "--source=HEAD", "--staged", "--worktree", "plan");
  writeFileSync(
    join(root, "plan", "BOARD.md"),
    board().replace("| T2   | S1     | todo   |         |", "| T2   | S1     | todo   | FAIL    |"),
  );
  git(root, "commit", "-q", "-am", "docs(board): someone else's verdict");
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ recover .*not provably this land's board commit/);
  const ledger = readLedger(root, ID);
  assert.equal(ledger.state, "merging");
  assert.match(ledger.merge.carry.patch, /^\+\| T2 +\| S1 +\| doing/m);
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T1 +\| S1 +\| verify +\|/);
});

// R1b-5 round 4 item 3: a revert in progress was taken for the land's own pick and aborted.
test("a revert in progress is not the land's pick: left alone, the land stops", () => {
  const { shas } = build({ "src/a.txt": "a\n" });
  killedWhilePicking(shas);
  const r1 = commitFile(root, "r1.txt", "one\n");
  const r2 = commitFile(root, "r2.txt", "two\n");
  commitFile(root, "r2.txt", "two changed\n");
  spawnSync("git", ["-C", root, "revert", "--no-edit", r1, r2], { env: gitEnv }); // stops on r2
  writeFileSync(join(root, "r2.txt"), "HAND WORK\n");
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ recover +git is in the middle of a revert that is not this land's/);
  assert.ok(existsSync(join(root, ".git", "REVERT_HEAD")), "the revert is left alone");
  assert.equal(readFileSync(join(root, "r2.txt"), "utf8"), "HAND WORK\n");
});

// R1b-5 round 4 item 3: someone's cherry-pick sequence, its first commit resolved and committed by
// hand (no CHERRY_PICK_HEAD, the sequencer left for the rest), was aborted as the land's own.
test("a cherry-pick sequence with no planned commit left in it is not the land's: left alone", () => {
  const { shas } = build({ "src/a.txt": "a\n" });
  killedWhilePicking(shas);
  git(root, "checkout", "-q", "-b", "foreign");
  const x = commitFile(root, "foreign/x.txt", "x\n");
  const y = commitFile(root, "foreign/y.txt", "y\n");
  git(root, "checkout", "-q", "main");
  commitFile(root, "foreign/x.txt", "main x\n");
  spawnSync("git", ["-C", root, "cherry-pick", x, y], { env: gitEnv }); // stops on x
  writeFileSync(join(root, "foreign", "x.txt"), "resolved by hand\n");
  git(root, "add", "foreign/x.txt");
  git(root, "commit", "-q", "-m", "x, resolved by hand");
  assert.deepEqual(pickInProgressFiles(), ["sequencer"]);
  const pf = merge(ID, "--preflight");
  assert.equal(pf.status, 1, out(pf));
  assert.match(
    pf.stdout,
    /✗ recover +git is in the middle of a cherry-pick that is not this land's/,
  );
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(
    res.stdout,
    /✗ recover +git is in the middle of a cherry-pick that is not this land's/,
  );
  assert.deepEqual(pickInProgressFiles(), ["sequencer"]); // left alone
});

// R1b-5 round 4 item 3 (LOW): the land's own planned commit, picked by hand and its conflict resolved
// and staged, was aborted with the resolution.
test("a planned pick with a resolution staged by hand is left alone", () => {
  const { shas } = build({ "src/c.txt": "branch side\n" });
  commitFile(root, "src/c.txt", "main side\n");
  killedWhilePicking(shas);
  spawnSync("git", ["-C", root, "cherry-pick", shas[0]], { env: gitEnv }); // conflict
  writeFileSync(join(root, "src", "c.txt"), "resolved by hand\n");
  git(root, "add", "src/c.txt");
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ recover .*a resolution staged by hand/);
  assert.deepEqual(pickInProgressFiles(), ["CHERRY_PICK_HEAD"]);
  assert.equal(readFileSync(join(root, "src", "c.txt"), "utf8"), "resolved by hand\n");
});

// R1b-5 round 4 item 4: a parallel lane's cell write while the gate ran made the rollback refuse, and
// `next` said to clear it; a plain rerun carries it and lands.
test("a lane's cell write during the gate: next says to land again, and the rerun lands", () => {
  // The gate is green; on its first run, T2's lane writes its status cell on main meanwhile.
  const once = join(home, "write-once");
  writeFileSync(once, "");
  const writer = `import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
if (existsSync(${JSON.stringify(once)})) {
  rmSync(${JSON.stringify(once)});
  const b = readFileSync("plan/BOARD.md", "utf8");
  writeFileSync("plan/BOARD.md", b.replace("| T2   | S1     | todo   |", "| T2   | S1     | doing  |"));
}
`;
  commitFile(root, "gate.mjs", writer);
  const { path } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: null });
  openLane("T2");
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ rollback main is not clean/);
  assert.doesNotMatch(res.stdout, /next: .*clear/);
  assert.match(res.stdout, /next: .*run the same land again/);
  mustLand();
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T2 +\| S1 +\| doing +\|/);
});

// R1b-5 round 4 item 5: the land's own board commit with a later commit after it stayed `merging`,
// named "not this land's".
test("a land killed after its board commit is recorded merged though a commit came after it", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  landKilledAt(KILL_AT_COMMIT, "after");
  const committed = head();
  commitFile(root, "src/next.txt", "n\n", "feat: another lane's pick");
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /✓ recover +a killed run had made the board commit/);
  assert.match(res.stdout, /feat: another lane's pick: after it, not this land's/);
  const ledger = readLedger(root, ID);
  assert.equal(ledger.state, "merged");
  assert.equal(ledger.merge.boardCommit, committed);
});

// R1b-5 round 4 item 5: a hook grew the board commit by a file; killed after it, the rerun named the
// land's own commit "not this land's" with no way out. The recovery it prints works as written.
test("a board commit a hook grew stops the rerun with a recovery that works", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho gen > generated.txt\ngit add generated.txt\n");
  chmodSync(hook, 0o755);
  landKilledAt(KILL_AT_COMMIT, "after");
  const grown = head();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ recover .*not provably this land's board commit: .*generated\.txt/);
  assert.doesNotMatch(res.stdout, /not this land's$/m);
  const reset = new RegExp(`git reset --keep ${grown.slice(0, 7)}~1`);
  assert.match(res.stdout, reset);
  git(root, "reset", "--keep", `${grown}~1`); // the recovery, as printed
  mustLand();
  assert.equal(readLedger(root, ID).state, "merged");
  assert.equal(status(), "");
});

// R1b-5 round 4 item 6: at recording, the preflight skipped main's row, so a stray source edit read as
// "the land clears it" (the land then refused it).
test("the preflight after a kill at recording still names other changes on main", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  landKilledAt(KILL_AT_COMMIT, "before");
  writeFileSync(join(root, "gate.mjs"), `${GATE_JS}// stray\n`);
  const pf = merge(ID, "--preflight");
  assert.equal(pf.status, 1, out(pf));
  assert.match(pf.stdout, /✓ recover +a killed land was writing the board: the land clears it/);
  assert.match(pf.stdout, /✗ main +main has 1 uncommitted change\(s\) the land cannot carry/);
  assert.match(pf.stdout, /gate\.mjs: not a board file/);
});

test("a stopped exec lane lands only with its branch named, and is then adopted", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  writeLedger(root, { ...readLedger(root, ID), state: "stopped" });
  const refused = merge(ID, "--message", "docs(board): land T1");
  assert.equal(refused.status, 2, out(refused));
  assert.match(
    out(refused),
    /"stopped": land it anyway only on the owner's call, with --branch agentry\/T1/,
  );
  mustLand("--branch", BRANCH);
  const ledger = readLedger(root, ID);
  assert.equal(ledger.origin, "adopted");
  assert.equal(ledger.adoptedFrom, "stopped");
  assert.equal(ledger.state, "merged");
  // merge.landed holds the commits as they are on main, and the board commit after them.
  assert.equal(git(root, "rev-parse", "HEAD~1"), ledger.merge.landed.at(-1));
  assert.equal(head(), ledger.merge.boardCommit);
});

test("an untracked file on main blocks the start: nothing is picked", () => {
  build({ "src/a.txt": "a\n" });
  writeFileSync(join(root, "stray.txt"), "untracked\n");
  const pre = head();
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /✗ main +main is not clean: 1 change\(s\)/);
  assert.match(out(res), /\?\? stray\.txt/);
  assert.equal(head(), pre);
});

test("a conflict midway through the picks aborts and leaves main byte-identical to preHead", () => {
  build({ "src/ok.txt": "fine\n", "src/c.txt": "branch side\n" });
  commitFile(root, "src/c.txt", "main side\n");
  const pre = head();
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ land +cherry-pick stopped on/);
  assert.match(res.stdout, /aborted: main is back at/);
  assert.match(res.stdout, /next: ask the builder to rebase agentry\/T1 onto main/);
  assert.equal(head(), pre); // the first, clean pick is gone too
  assert.equal(status(), "");
  assert.equal(git(root, "diff", "--stat", pre), "");
  assert.equal(readFileSync(join(root, "src", "c.txt"), "utf8"), "main side\n");
  assert.equal(existsSync(join(root, "src", "ok.txt")), false);
  assert.equal(existsSync(join(root, ".git", "CHERRY_PICK_HEAD")), false);
});

test("a branch with a merge commit is refused before any pick", () => {
  const { path } = build({ "src/a.txt": "a\n" });
  commitFile(root, "main.txt", "m\n");
  git(path, "merge", "-q", "--no-edit", "main");
  const pre = head();
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /merge commit\(s\), which a cherry-pick cannot land/);
  assert.equal(head(), pre);
});

// A flagged task must land with a verdict the rule accepts; the fixture's T1 has "PASS" and this rule asks
// for "SIGNED", so the done task gets a new flagged-needs-verdict finding no load check foresees.
function commitFlaggedSpec() {
  const flagged = structuredClone(SPEC);
  flagged.kinds.task.fields.flagged = { column: "Sprint", type: "flag" };
  flagged.rules.push({
    rule: "flagged-needs-verdict",
    kind: "task",
    flag: "flagged",
    verdict: "verdict",
    pass: ["SIGNED"],
  });
  commitSpec(flagged);
}
// With it, the land picks, gates green and stops at its record with main at preHead plus its pick.
function landStoppedAtRecord() {
  commitFlaggedSpec();
  build({ "src/a.txt": "a\n" });
  const before = { board: board(), sprint: sprint() };
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ record +board check: 1 new finding\(s\).*restored/);
  assert.match(res.stdout, /flagged-needs-verdict T1/);
  assert.deepEqual({ board: board(), sprint: sprint() }, before);
  assert.equal(status(), "");
  assert.equal(readLedger(root, ID).merge.step, "gated");
  return readLedger(root, ID).merge;
}
const SIGNED = ["| T1   | S1     | verify | PASS    |", "| T1   | S1     | verify | SIGNED  |"];
/** The owner's fix for the finding, committed on main: T1's verdict, plus `extra` files ({ file: text }). */
function commitVerdictFix(extra = {}) {
  writeFileSync(join(root, "plan", "BOARD.md"), board().replace(...SIGNED));
  for (const [file, text] of Object.entries(extra)) writeFileSync(join(root, file), text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "docs(board): sign T1");
}

test("a board write that adds a finding is restored and stops; a fix touching a non-board file won't resume", () => {
  const { landed } = landStoppedAtRecord();
  commitVerdictFix({ "notes.txt": "why\n" });
  const again = merge(ID, "--message", "docs(board): land T1");
  assert.equal(again.status, 1, out(again));
  assert.match(again.stdout, /main has moved since this land picked 1 commit\(s\) onto/);
  assert.match(again.stdout, /[0-9a-f]{7} docs\(board\): sign T1: not this land's/);
  assert.match(again.stdout, /next: show the owner git log --first-parent/);
  assert.deepEqual(readLedger(root, ID).merge.landed, landed);
  assert.equal(readLedger(root, ID).state, "merging");
});

// Field 79: the record stopped on a finding, the owner committed the fix, and the rerun refused past it.
test("after the gate passed, the owner's board-only fix commit resumes the land; its board commit goes on top", () => {
  const { landed } = landStoppedAtRecord();
  const gates = readLedger(root, ID).gates.length;
  commitVerdictFix();
  const fix = head();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /1 commit\(s\) already on main: resuming/);
  assert.match(res.stdout, /docs\(board\): sign T1: after the gate, not a pick/);
  assert.match(res.stdout, /already passed/);
  assert.equal(git(root, "rev-parse", "HEAD~1"), fix);
  assert.equal(git(root, "rev-parse", "HEAD~2"), landed[0]);
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T1 +\| S1 +\| done +\| SIGNED/);
  assert.equal(readLedger(root, ID).state, "merged");
  assert.equal(readLedger(root, ID).gates.length, gates); // no second gate
  assert.equal(status(), "");
});

test("after the gate passed, a commit of only Agentry's config resumes the land", () => {
  landStoppedAtRecord();
  commitSpec(SPEC); // the rule dropped: .agentry/process.json and workflow.json only
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /spec: after the gate, not a pick; the board commit goes on top/);
  assert.equal(git(root, "log", "-1", "--format=%s", "HEAD~1"), "spec");
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T1 +\| S1 +\| done +\|/);
});

test("a board-only commit after the picks, before the gate passed, still refuses the resume", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path });
  const preHead = head();
  git(root, "cherry-pick", shas[0]);
  const landed = [head()];
  const ledger = readLedger(root, ID);
  writeLedger(root, {
    ...ledger,
    state: "merging",
    merge: {
      preHead,
      planned: shas,
      landed,
      tip: shas[0],
      stateBefore: "verified",
      step: "landed",
      at: "2026-11-01T00:00:00.000Z",
    },
  });
  commitVerdictFix();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /main has moved since this land picked 1 commit\(s\)/);
  assert.match(res.stdout, /docs\(board\): sign T1: not this land's/);
  assert.doesNotMatch(res.stdout, /gate tier/);
  assert.deepEqual(readLedger(root, ID).merge.landed, landed);
});

test("a land killed at recording on top of the owner's fix commit is finished by the rerun", () => {
  landStoppedAtRecord();
  commitVerdictFix();
  const fix = head();
  landKilledAt(KILL_AT_COMMIT, "before");
  assert.equal(readLedger(root, ID).merge.record.on, fix);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /✓ recover +took back the board writes a killed run left uncommitted/);
  assert.equal(git(root, "rev-parse", "HEAD~1"), fix);
  assert.equal(readLedger(root, ID).state, "merged");
  assert.equal(status(), "");
});

/** `board set <args> --apply` on main: a recorded board write, left uncommitted. */
function boardSet(...args) {
  const res = spawnSync(
    "node",
    [join(dirname(LANE), "board.mjs"), "set", ...args, "--apply", "--root", root],
    {
      encoding: "utf8",
      env: { ...gitEnv, HOME: home, NO_COLOR: "1" },
    },
  );
  assert.equal(res.status, 0, out(res));
}

// Field 79: the verdict the board check needs, written by `board set`, was set aside and checked without.
test("a recorded board set the board check needs is carried into the board commit: one land, green", () => {
  commitFlaggedSpec();
  build({ "src/a.txt": "a\n" });
  const pre = head();
  boardSet("task", "T1", "verdict=SIGNED");
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(
    res.stdout,
    /✓ carry +plan\/BOARD\.md: your recorded board write, carried into the board commit/,
  );
  assert.match(res.stdout, /✓ record .*board check: no new findings/);
  assert.equal(chainSince(pre).length, 2); // the pick and the one board commit
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T1 +\| S1 +\| done +\| SIGNED/);
  assert.equal(status(), "");
  assert.equal(readLedger(root, ID).merge.writes, undefined);
});

test("a recorded board write the board check refuses stops the land and stays uncommitted on main", () => {
  build({ "src/a.txt": "a\n" });
  boardSet("task", "T2", "status=done"); // done without its commit or handoff
  const dirty = board();
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ record +board check: \d+ new finding\(s\)/);
  assert.match(res.stdout, /done-has-evidence T2/);
  assert.equal(board(), dirty);
  assert.equal(status(), "M plan/BOARD.md");
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T2 +\| S1 +\| todo/);
  const ledger = readLedger(root, ID);
  assert.equal(ledger.merge.step, "gated");
  assert.equal(ledger.merge.writes, undefined); // back on main, so the ledger let go
});

test("a land killed at recording with a recorded board write on main finishes on the rerun, the write committed", () => {
  commitFlaggedSpec();
  build({ "src/a.txt": "a\n" });
  boardSet("task", "T1", "verdict=SIGNED");
  landKilledAt(KILL_AT_COMMIT, "before", "--branch", BRANCH);
  assert.ok(readLedger(root, ID).merge.record.base["plan/BOARD.md"]);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T1 +\| S1 +\| done +\| SIGNED/);
  assert.equal(status(), "");
  assert.equal(readLedger(root, ID).state, "merged");
});

test("a land killed at recording before its first write, the recorded write back on main, takes it as its own", () => {
  commitFlaggedSpec();
  build({ "src/a.txt": "a\n" });
  boardSet("task", "T1", "verdict=SIGNED");
  const written = board();
  landKilledAt(KILL_AT_COMMIT, "before", "--branch", BRANCH);
  writeFileSync(join(root, "plan", "BOARD.md"), written); // as main was before the record wrote
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /✓ recover +took back the board writes a killed run left uncommitted/);
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T1 +\| S1 +\| done +\| SIGNED/);
  assert.equal(status(), "");
});

test("a commit hook that refuses the board commit restores the files; the rerun resumes and commits", () => {
  build({ "src/a.txt": "a\n" });
  const hook = join(root, ".git", "hooks", "commit-msg");
  writeFileSync(
    hook,
    '#!/bin/sh\ngrep -q "^docs(board)" "$1" || { echo "bad subject" >&2; exit 1; }\n',
  );
  chmodSync(hook, 0o755);
  const first = merge(ID, "--branch", BRANCH, "--message", "land T1");
  assert.equal(first.status, 1, out(first));
  assert.match(first.stdout, /✗ commit +bad subject/);
  assert.match(first.stdout, /the board files are restored/);
  assert.equal(status(), "");
  const landedHead = head();
  const gates = readLedger(root, ID).gates.length;

  const second = merge(ID, "--message", "docs(board): land T1");
  assert.equal(second.status, 0, out(second));
  assert.match(second.stdout, /1 commit\(s\) already on main: resuming/);
  assert.match(second.stdout, /already passed: full ran on main/);
  assert.equal(git(root, "rev-parse", "HEAD~1"), landedHead);
  assert.equal(readLedger(root, ID).gates.length, gates);
  // And a third run changes nothing.
  const third = merge(ID, "--message", "docs(board): land T1");
  assert.equal(third.status, 0, out(third));
  assert.match(third.stdout, /already merged/);
  assert.equal(git(root, "rev-parse", "HEAD~1"), landedHead);
});

test("the board commit message is refused when it carries AI attribution", () => {
  build({ "src/a.txt": "a\n" });
  const pre = head();
  const res = merge(
    ID,
    "--branch",
    BRANCH,
    "--message",
    "docs(board): land T1\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
  );
  assert.equal(res.status, 2, out(res));
  assert.match(res.stderr, /carries AI attribution/);
  assert.equal(head(), pre);
});

test("a missing extension skill is exit 2; an unrecorded check refuses the land; a recorded one lets it", () => {
  commitSpec({ ...SPEC, extensions: { merge: { checks: ["repo-merge"] } } });
  build({ "src/a.txt": "a\n" });
  const pf = merge(ID, "--branch", BRANCH, "--preflight");
  assert.equal(pf.status, 2, out(pf));
  assert.match(out(pf), /repo-merge: no \.claude\/skills\/repo-merge\/SKILL\.md/);

  mkdirSync(join(root, ".claude", "skills", "repo-merge"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "repo-merge", "SKILL.md"), "# repo merge\n");
  writeFileSync(join(root, ".git", "info", "exclude"), ".claude/\n");
  const pre = head();
  const refused = merge(ID, "--message", "docs(board): land T1");
  assert.equal(refused.status, 2, out(refused));
  assert.match(out(refused), /repo-merge: not recorded/);
  assert.match(out(refused), /next: lane merge T1 --check repo-merge=pass\|fail/);
  assert.equal(head(), pre);

  const bad = merge(ID, "--check", "other=pass");
  assert.equal(bad.status, 2, out(bad));
  assert.match(bad.stderr, /"other" is not in extensions.merge.checks/);
  const rec = merge(ID, "--check", "repo-merge=pass", "--note", "looked at it");
  assert.equal(rec.status, 0, out(rec));
  assert.match(rec.stdout, /repo-merge: pass/);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /repo-merge: pass \(looked at it\)/);
});

test("a check recorded on an older tip does not count once the branch moved", () => {
  commitSpec({ ...SPEC, extensions: { merge: { checks: ["repo-merge"] } } });
  mkdirSync(join(root, ".claude", "skills", "repo-merge"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "repo-merge", "SKILL.md"), "# repo merge\n");
  writeFileSync(join(root, ".git", "info", "exclude"), ".claude/\n");
  const { path } = build({ "src/a.txt": "a\n" });
  assert.equal(merge(ID, "--branch", BRANCH, "--preflight").status, 0);
  assert.equal(merge(ID, "--check", "repo-merge=pass").status, 0);
  commitFile(path, "src/b.txt", "b\n");
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /repo-merge: pass on .*, but the branch is at .*: record it again/);
});

// The gate with a manual checklist: `ui-smoke` for a change under src/ui/ or a flagged lane, `owner-ok`
// on every land; `repo-merge` a skill check beside them.
const withChecklist = () => {
  commitSpec({
    ...SPEC,
    gate: {
      ...SPEC.gate,
      checklist: [
        {
          name: "ui-smoke",
          text: "Open each changed screen; no errors in the console",
          when: { any: ["src/ui/**"], flag: true },
        },
      ],
    },
    extensions: { merge: { checks: ["repo-merge"] } },
  });
  mkdirSync(join(root, ".claude", "skills", "repo-merge"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "repo-merge", "SKILL.md"), "# repo merge\n");
  writeFileSync(join(root, ".git", "info", "exclude"), ".claude/\n");
};

test("an applicable checklist item blocks the land until recorded pass; skill and item records stay apart", () => {
  withChecklist();
  build({ "src/ui/a.txt": "a\n" });
  const pf = merge(ID, "--branch", BRANCH, "--preflight");
  assert.equal(pf.status, 0, out(pf));
  assert.match(pf.stdout, /repo-merge: not recorded/);
  assert.match(
    pf.stdout,
    /ui-smoke: not recorded: "Open each changed screen; no errors in the console"/,
  );
  assert.match(pf.stdout, /0\/2 passed/);
  assert.equal(merge(ID, "--check", "repo-merge=pass").status, 0);
  const pre = head();
  const refused = merge(ID, "--message", "docs(board): land T1");
  assert.equal(refused.status, 2, out(refused));
  assert.match(out(refused), /next: lane merge T1 --check ui-smoke=pass\|fail/);
  assert.equal(head(), pre);
  const skill = readLedger(root, ID).checks["repo-merge"];
  const rec = merge(ID, "--check", "ui-smoke=pass", "--note", "seen");
  assert.equal(rec.status, 0, out(rec));
  assert.match(rec.stdout, /ui-smoke: pass on/);
  const checks = readLedger(root, ID).checks;
  assert.deepEqual(checks["repo-merge"], skill);
  assert.equal(checks["ui-smoke"].result, "pass");
  // Recording the skill again leaves the item's record as it was.
  const item = checks["ui-smoke"];
  assert.equal(merge(ID, "--check", "repo-merge=pass", "--note", "again").status, 0);
  assert.deepEqual(readLedger(root, ID).checks["ui-smoke"], item);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /ui-smoke: pass \(seen\)/);
});

test("a checklist item that does not apply is not listed", () => {
  withChecklist();
  build({ "src/a.txt": "a\n" });
  const pf = merge(ID, "--branch", BRANCH, "--preflight");
  assert.doesNotMatch(pf.stdout, /ui-smoke/);
  assert.match(pf.stdout, /0\/1 passed/);
});

test("a checklist item recorded on an older tip is pending again", () => {
  withChecklist();
  const { path } = build({ "src/ui/a.txt": "a\n" });
  assert.equal(merge(ID, "--branch", BRANCH, "--preflight").status, 0);
  assert.equal(merge(ID, "--check", "repo-merge=pass").status, 0);
  assert.equal(merge(ID, "--check", "ui-smoke=pass").status, 0);
  commitFile(path, "src/ui/b.txt", "b\n");
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /ui-smoke: pass on .*, but the branch is at .*: record it again/);
});

test("--check naming neither a merge check nor a checklist item exits 2 and writes nothing", () => {
  withChecklist();
  build({ "src/ui/a.txt": "a\n" });
  assert.equal(merge(ID, "--branch", BRANCH, "--preflight").status, 0);
  const before = readLedger(root, ID);
  const bad = merge(ID, "--check", "other=pass");
  assert.equal(bad.status, 2, out(bad));
  assert.match(
    bad.stderr,
    /"other" is not in extensions\.merge\.checks \(repo-merge\) or gate\.checklist \(ui-smoke\)/,
  );
  const usage = merge(ID, "--check", "ui-smoke");
  assert.equal(usage.status, 2, out(usage));
  assert.match(usage.stderr, /--check takes <name>=pass\|fail, not "ui-smoke"/);
  assert.deepEqual(readLedger(root, ID), before);
});

test("an old gate.command or gate.quick refuses the preflight at load, naming gate.tiers, writing nothing", () => {
  setSpec({
    ...SPEC,
    gate: { command: ["node", "gate.mjs"], quick: { command: ["x"], only: ["docs/**"] } },
  });
  build({ "src/a.txt": "a\n" });
  const pf = merge(ID, "--branch", BRANCH, "--preflight");
  assert.equal(pf.status, 2, out(pf));
  assert.match(out(pf), /gate\.command replaced by gate\.tiers \(0\.3\): make it the last tier/);
  assert.match(out(pf), /gate\.quick replaced by gate\.tiers: a tier with "when"/);
  assert.equal(readLedger(root, ID), null);
});

test("a checklist name equal to a merge check is refused at load", () => {
  const spec = {
    ...SPEC,
    gate: { ...SPEC.gate, checklist: [{ name: "repo-merge", text: "look" }] },
    extensions: { merge: { checks: ["repo-merge"] } },
  };
  setSpec(spec);
  build({ "src/a.txt": "a\n" });
  const pf = merge(ID, "--branch", BRANCH, "--preflight");
  assert.equal(pf.status, 2, out(pf));
  assert.match(
    out(pf),
    /gate\.checklist\[0\]\.name "repo-merge" is also an extensions\.merge\.checks name/,
  );
});

test("a recorded fail stops the land", () => {
  commitSpec({ ...SPEC, extensions: { merge: { checks: ["repo-merge"] } } });
  mkdirSync(join(root, ".claude", "skills", "repo-merge"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "repo-merge", "SKILL.md"), "# repo merge\n");
  writeFileSync(join(root, ".git", "info", "exclude"), ".claude/\n");
  build({ "src/a.txt": "a\n" });
  merge(ID, "--branch", BRANCH, "--preflight");
  merge(ID, "--check", "repo-merge=fail", "--note", "the screen is off");
  const pre = head();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ checks +0\/1 passed/);
  assert.equal(head(), pre);
});

test("a process file without a gate is refused before anything lands", () => {
  const { gate: _, ...spec } = SPEC;
  commitSpec(spec);
  build({ "src/a.txt": "a\n" });
  const pre = head();
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /no gate/);
  assert.equal(head(), pre);
});

test("an id not on the board is refused before anything lands", () => {
  create(root, { id: "T9", base: "main" });
  commitFile(join(root, ".agentry", "run", "worktrees", "T9"), "x.txt", "x\n");
  const pre = head();
  const res = merge("T9", "--branch", "agentry/T9", "--message", "docs(board): land T9");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /no task "T9" on the board/);
  assert.equal(head(), pre);
});

test("an exec lane that is still verifying does not land", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  writeLedger(root, { ...readLedger(root, ID), state: "verifying" });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /lane is "verifying"/);
});

test("no ledger and no --branch: exit 2 naming exec and --branch", () => {
  const res = merge(ID, "--preflight");
  assert.equal(res.status, 2, out(res));
  assert.match(res.stderr, /\/agentry:exec T1, or adopt a branch with --branch/);
});

test("usage: exactly one mode, options only with their mode, a bad id", () => {
  assert.equal(merge(ID).status, 2);
  assert.equal(merge(ID, "--preflight", "--push").status, 2);
  assert.match(merge(ID, "--push", "--note", "x").stderr, /--note does not go with --push/);
  assert.match(merge("a..b", "--preflight").stderr, /must not contain/);
});

test("push: never refuses, ask needs --approved, auto and approved push to the upstream", () => {
  const remote = realpathSync(mkdtempSync(join(tmpdir(), "merge-remote-")));
  try {
    git(remote, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "-u", "origin", "main");
    build({ "src/a.txt": "a\n" });
    const early = merge(ID, "--push");
    assert.equal(early.status, 2, out(early));
    mustLand("--branch", BRANCH);

    setPush("never");
    const never = merge(ID, "--push", "--approved");
    assert.equal(never.status, 2, out(never));
    assert.match(never.stderr, /merge.push is "never"/);
    assert.notEqual(git(remote, "rev-parse", "main"), head());

    setPush("ask");
    const ask = merge(ID, "--push");
    assert.equal(ask.status, 2, out(ask));
    assert.match(ask.stderr, /ask the owner first, then pass --approved/);
    assert.notEqual(git(remote, "rev-parse", "main"), head());
    const approved = merge(ID, "--push", "--approved");
    assert.equal(approved.status, 0, out(approved));
    assert.match(approved.stdout, /the owner approved/);
    assert.equal(git(remote, "rev-parse", "main"), head());
    assert.match(approved.stdout, /next: lane merge T1 --cleanup/);

    setPush("auto");
    const again = merge(ID, "--push");
    assert.equal(again.status, 0, out(again));
    assert.match(again.stdout, /already pushed/);
  } finally {
    rmSync(remote, { recursive: true, force: true });
  }
});

test("after the land, next names the push the policy allows (ask by default)", () => {
  build({ "src/a.txt": "a\n" });
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(
    res.stdout,
    /next: ask the owner to push main; on yes: lane merge T1 --push --approved/,
  );
});

test("cleanup removes the worktree and branch by branch; ignored files hold it until discarded", () => {
  const { path } = build({ "src/a.txt": "a\n" });
  writeFileSync(join(path, ".gitignore"), ".agentry/run/\nshots/\n");
  git(path, "add", ".gitignore");
  git(path, "commit", "-q", "-m", "ignore shots");
  mustLand("--branch", BRANCH);
  mkdirSync(join(path, "shots"));
  writeFileSync(join(path, "shots", "probe.png"), "png");

  const held = merge(ID, "--cleanup");
  assert.equal(held.status, 2, out(held));
  assert.match(held.stderr, /holds 1 ignored file\(s\)/);
  assert.match(held.stderr, /shots\//);
  assert.ok(existsSync(path));

  const res = merge(ID, "--cleanup", "--discard-ignored");
  assert.equal(res.status, 0, out(res));
  assert.equal(existsSync(path), false);
  assert.equal(git(root, "branch", "--list", BRANCH), "");
  const again = merge(ID, "--cleanup");
  assert.equal(again.status, 0, out(again));
  assert.match(again.stdout, /already done/);
});

test("cleanup discards cleanup.disposable files without asking, and still asks for any other", () => {
  commitSpec({ ...SPEC, cleanup: { disposable: ["**/.cache", "**/*.bin"] } });
  const { path } = build({ "src/a.txt": "a\n" });
  writeFileSync(join(path, ".gitignore"), ".agentry/run/\n.cache/\n*.bin\nshots/\n");
  git(path, "add", ".gitignore");
  git(path, "commit", "-q", "-m", "ignore build output");
  mustLand("--branch", BRANCH);
  mkdirSync(join(path, ".cache"));
  writeFileSync(join(path, ".cache", "index"), "x");
  writeFileSync(join(path, "src", "out.bin"), "x");
  mkdirSync(join(path, "shots"));
  writeFileSync(join(path, "shots", "probe.png"), "png");

  const held = merge(ID, "--cleanup");
  assert.equal(held.status, 2, out(held));
  assert.match(held.stderr, /holds 1 ignored file\(s\)/);
  assert.match(held.stderr, /shots\//);
  assert.doesNotMatch(held.stderr, /\.cache|out\.bin/);
  assert.ok(existsSync(path));

  rmSync(join(path, "shots"), { recursive: true });
  const res = merge(ID, "--cleanup");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /discarded 2 disposable path\(s\)/);
  assert.equal(existsSync(path), false);
});

test("cleanup counts an ignored folder once: node_modules of 300 files is 1 disposable path", () => {
  const { path } = build({ "src/a.txt": "a\n" });
  writeFileSync(join(path, ".gitignore"), ".agentry/run/\nnode_modules/\n");
  git(path, "add", ".gitignore");
  git(path, "commit", "-q", "-m", "ignore node_modules");
  mustLand("--branch", BRANCH);
  mkdirSync(join(path, "node_modules", "pkg"), { recursive: true });
  for (let i = 0; i < 300; i++) writeFileSync(join(path, "node_modules", "pkg", `f${i}.js`), "x");
  const res = merge(ID, "--cleanup");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /discarded 1 disposable path\(s\)/);
  assert.equal(existsSync(path), false);
});

test("after cleanup the ledger names no next step, so session close shows none", () => {
  build({ "src/a.txt": "a\n" });
  mustLand("--branch", BRANCH);
  assert.match(readLedger(root, ID).next ?? "", /lane merge T1/);
  assert.equal(merge(ID, "--cleanup").status, 0);
  assert.equal(readLedger(root, ID).next, null);
  const session = spawnSync("node", [LANE, "session", "close", "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, NO_COLOR: "1" },
  });
  const mine = JSON.parse(session.stdout).ledgers.find((l) => l.id === ID);
  assert.equal(mine.next, null);
});

test("cleanup finds a custom-named, locked worktree by its branch", () => {
  git(root, "branch", "feature/x");
  const path = join(root, ".claude", "worktrees", "agent-1");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(join(root, ".git", "info", "exclude"), ".claude/\n");
  git(root, "worktree", "add", "-q", path, "feature/x");
  commitFile(path, "src/a.txt", "a\n");
  git(root, "worktree", "lock", path);
  mustLand("--branch", "feature/x");
  const res = merge(ID, "--cleanup");
  assert.equal(res.status, 0, out(res));
  assert.equal(existsSync(path), false);
  assert.equal(git(root, "branch", "--list", "feature/x"), "");
});

test("merge runs only from the main checkout", () => {
  const { path } = build({ "src/a.txt": "a\n" });
  const res = spawnSync("node", [LANE, "merge", ID, "--preflight", "--root", path], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home },
  });
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /run merge from the main checkout/);
});

// --- flaky reds, and a queued land that says so ------------------------------------------------------

// A land gate that fails once, in `test_budget`, then passes (the marker lives outside the repo); `again`
// is what the re-run does: "pass" or "fail".
const flakyLand = (again) => {
  const marker = join(home, "flaky-ran");
  const script = `const fs = require("node:fs");
if (fs.existsSync(${JSON.stringify(marker)}) && ${JSON.stringify(again)} === "pass") process.exit(0);
fs.writeFileSync(${JSON.stringify(marker)}, "");
console.log("FAILED test_budget");
process.exit(1);`;
  commitSpec({
    ...SPEC,
    gate: { tiers: [{ name: "full", command: ["node", "-e", script] }], flaky: ["test_budget"] },
  });
  build({ "src/a.txt": "a\n" });
};
const mainGates = () => readLedger(root, ID).gates.filter((g) => g.where === "main");

test("a land gate red only in listed flaky tests is re-run alone once; both runs are recorded; green lands", () => {
  flakyLand("pass");
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /re-run alone after a red only in flaky tests/);
  assert.deepEqual(
    mainGates().map((g) => [g.exit, g.flakyRed ?? null, g.rerun ?? false]),
    [
      [1, ["test_budget"], false],
      [0, null, true],
    ],
  );
  assert.equal(readLedger(root, ID).state, "merged");
});

test("a flaky red that fails again alone rolls main back and names the re-run, not the builder", () => {
  flakyLand("fail");
  const pre = head();
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.equal(head(), pre);
  assert.equal(mainGates().length, 2);
  assert.match(
    res.stdout,
    /test_budget \(listed in gate\.flaky\) failed again on the re-run alone/,
  );
  assert.doesNotMatch(res.stdout, /resume the builder/);
});

test("a re-run that fails in a different, unlisted test does not blame the flaky one", () => {
  const marker = join(home, "flaky-ran");
  const script = `const fs = require("node:fs");
const again = fs.existsSync(${JSON.stringify(marker)});
fs.writeFileSync(${JSON.stringify(marker)}, "");
console.log(again ? "FAILED test_real" : "FAILED test_budget");
process.exit(1);`;
  commitSpec({
    ...SPEC,
    gate: { tiers: [{ name: "full", command: ["node", "-e", script] }], flaky: ["test_budget"] },
  });
  build({ "src/a.txt": "a\n" });
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.equal(mainGates().length, 2);
  assert.doesNotMatch(res.stdout, /failed again on the re-run alone/);
  assert.match(res.stdout, /resume the builder/);
});

test("a flaky re-run refused on a dirty main is recorded and named in the gate row", () => {
  const marker = join(home, "flaky-ran");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");
console.log("FAILED test_budget");
process.exit(1);`;
  commitSpec({
    ...SPEC,
    gate: {
      tiers: [{ name: "full", command: ["node", "-e", script] }],
      flaky: ["test_budget"],
      concurrency: 2,
    },
  });
  build({ "src/a.txt": "a\n" });
  // Slot 2 is held by a process that leaves a stray file in main once the first run is over, then exits:
  // the re-run, queued behind it, finds main dirty.
  const stray = join(root, "stray.txt");
  const holderJs = `const fs = require("node:fs");
const t = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(marker)})) return;
  clearInterval(t);
  setTimeout(() => { fs.writeFileSync(${JSON.stringify(stray)}, "x"); process.exit(0); }, 1000);
}, 20);`;
  // Started from a launcher that exits, so init reaps it: a holder that is this test's own child would stay a
  // zombie, and a zombie's pid still looks held while merge blocks this test.
  const launch = spawnSync(
    "node",
    [
      "-e",
      `const c = require("node:child_process").spawn("node", ["-e", ${JSON.stringify(holderJs)}], { detached: true, stdio: "ignore" });
c.unref();
console.log(c.pid);`,
    ],
    { encoding: "utf8" },
  );
  const holder = { pid: Number(launch.stdout), kill: () => process.kill(Number(launch.stdout)) };
  const locks = join(root, ".agentry", "run", "gate-locks");
  mkdirSync(locks, { recursive: true });
  writeFileSync(
    join(locks, "slot-2.lock"),
    JSON.stringify({ pid: holder.pid, who: "lane T9", at: new Date().toISOString() }),
  );
  let res;
  try {
    res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  } finally {
    try {
      holder.kill();
    } catch {} // already gone: it leaves before the re-run's turn
  }
  assert.equal(res.status, 1, out(res));
  assert.deepEqual(
    mainGates().map((g) => [g.exit, g.flakyRed ?? null, g.rerun ?? false]),
    [[1, ["test_budget"], false]],
  );
  assert.match(res.stdout, /exit 1 in [\d.]+ s \(flaky re-run refused: main not clean\)/);
  assert.match(res.stdout, /the re-run was refused: main is not clean \(\?\? stray\.txt\)/);
});

test("a land gate red in an unlisted test is not re-run and still says to fix the branch", () => {
  commitSpec({
    ...SPEC,
    gate: {
      tiers: [
        {
          name: "full",
          command: ["node", "-e", 'console.log("FAILED test_real"); process.exit(1)'],
        },
      ],
      flaky: ["test_budget"],
    },
  });
  build({ "src/a.txt": "a\n" });
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.equal(mainGates().length, 1);
  assert.match(res.stdout, /resume the builder/);
});

const landLog = (n) => join(root, ".agentry", "run", "process", "runs", ID, `merge-gate-${n}.log`);
const logHas = (file, text) => existsSync(file) && readFileSync(file, "utf8").includes(text);

test("a queued land writes the waiting line at once, and slot acquired when it gets the slot", async () => {
  build({ "src/a.txt": "a\n" });
  const holder = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const locks = join(root, ".agentry", "run", "gate-locks");
  mkdirSync(locks, { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(
    join(locks, "slot-1.lock"),
    JSON.stringify({ pid: holder.pid, who: "lane T9", at }),
  );
  const args = [
    LANE,
    "merge",
    ID,
    "--branch",
    BRANCH,
    "--message",
    "docs(board): land T1",
    "--root",
    root,
  ];
  const child = spawn("node", args, {
    env: { ...gitEnv, HOME: home, NO_COLOR: "1" },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  try {
    const waiting = () => logHas(landLog(1), "waiting for gate slot 1 (held by lane T9 since ");
    for (let i = 0; i < 500 && !waiting(); i++) await sleep(20);
    assert.ok(waiting(), "no waiting line while the slot is held");
    assert.match(readFileSync(landLog(1), "utf8"), /held by lane T9 since \d\d:\d\d\)/);
    assert.equal(logHas(landLog(1), "slot acquired"), false);
    holder.kill("SIGKILL");
    assert.equal(await exited, 0);
    assert.equal(logHas(landLog(1), "slot acquired"), true);
    assert.equal(logHas(landLog(1), "gate tier full"), true);
  } finally {
    holder.kill("SIGKILL");
    child.kill("SIGKILL");
  }
});

test("the gate's output reaches the log while the gate is still running", async () => {
  build({ "src/a.txt": "a\n" });
  const hang = join(home, "hang");
  writeFileSync(hang, "");
  const args = [
    LANE,
    "merge",
    ID,
    "--branch",
    BRANCH,
    "--message",
    "docs(board): land T1",
    "--root",
    root,
  ];
  const child = spawn("node", args, {
    env: { ...gitEnv, HOME: home, NO_COLOR: "1", MERGE_TEST_HANG: hang },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  try {
    for (let i = 0; i < 500 && !logHas(landLog(1), "gate tier full"); i++) await sleep(20);
    assert.ok(logHas(landLog(1), "gate tier full"), "nothing in the log while the gate runs");
    assert.equal(child.exitCode, null, "the land had ended");
    rmSync(hang);
    child.kill("SIGKILL");
    await exited;
  } finally {
    child.kill("SIGKILL");
    const pgid = gateGroup();
    endGroup(pgid);
  }
});

// --- the workflow file's `commits` rules ------------------------------------------------------------

const RULES = { commits: { subjectMax: 72, forbid: ["^Co-Authored-By:"] } };
const LONG_SUBJECT = `feat: ${"x".repeat(74)}`;
const ledgerBytes = () =>
  readFileSync(join(root, ".agentry", "run", "process", "ledger", `${ID}.json`), "utf8");
const indexState = () => git(root, "ls-files", "-s");

function buildSubjects(...subjects) {
  const { path } = create(root, { id: ID, base: "main" });
  const shas = subjects.map((subject, i) => commitFile(path, `src/f${i}.txt`, `${i}\n`, subject));
  return { path, shas };
}

test("preflight checks the commits to land against the commits rules: a bad subject is red, a good one ticks", () => {
  commitSpec({ ...SPEC, ...RULES });
  const { path, shas } = buildSubjects("feat: fine", LONG_SUBJECT);
  execLedger({ path, gated: shas[0] });
  const bad = merge(ID, "--preflight");
  assert.equal(bad.status, 1, out(bad));
  assert.match(
    bad.stdout,
    new RegExp(
      `✗ commits +${shas[1].slice(0, 7)} "${LONG_SUBJECT}": subject is 80 chars \\(commits\\.subjectMax 72\\)`,
    ),
  );
  assert.match(bad.stdout, /✓ commits +2 to land/);

  git(path, "reset", "-q", "--hard", "HEAD~1");
  git(path, "commit", "--allow-empty", "-q", "-m", "feat: also fine");
  const good = merge(ID, "--preflight");
  assert.equal(good.status, 0, out(good));
  assert.match(good.stdout, /✓ commits +2 checked against commits/);
});

test("a land with a bad subject stops before any pick: main's HEAD, index and the ledger are untouched", () => {
  commitSpec({ ...SPEC, ...RULES });
  const { path, shas } = buildSubjects("feat: fine", LONG_SUBJECT);
  execLedger({ path, gated: shas[0] });
  const [pre, indexed, ledger] = [head(), indexState(), ledgerBytes()];
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(
    res.stdout,
    new RegExp(`✗ commits +${shas[1].slice(0, 7)} "${LONG_SUBJECT}": subject is 80 chars`),
  );
  assert.match(res.stdout, /reword them on the branch/);
  assert.doesNotMatch(res.stdout, /✓ land|picked/);
  assert.equal(head(), pre);
  assert.equal(indexState(), indexed);
  assert.equal(status(), "");
  assert.equal(ledgerBytes(), ledger);
  assert.equal(readLedger(root, ID).merge, undefined, "no merge record");
});

test("a forbidden trailer in a commit is refused at the land; reworded, the land goes through", () => {
  commitSpec({ ...SPEC, ...RULES });
  const { path } = buildSubjects("feat: x");
  git(path, "commit", "--amend", "-q", "-m", "feat: x", "-m", "Why.\n\nCo-Authored-By: Q <q@x.y>");
  execLedger({ path, gated: git(path, "rev-parse", "HEAD") });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(
    res.stdout,
    /✗ commits +[0-9a-f]{7} "feat: x": message matches commits\.forbid\[0\]/,
  );
  git(path, "commit", "--amend", "-q", "-m", "feat: x");
  execLedger({ path, gated: git(path, "rev-parse", "HEAD") });
  mustLand();
  assert.equal(readLedger(root, ID).state, "merged");
});

test("with no commits key the row is · and nothing is checked", () => {
  const { path, shas } = buildSubjects(LONG_SUBJECT);
  execLedger({ path, gated: shas[0] });
  const pf = merge(ID, "--preflight");
  assert.equal(pf.status, 0, out(pf));
  assert.match(pf.stdout, /· commits +no rules \(commits in the workflow file\)/);
  const res = mustLand();
  assert.match(res.stdout, /· commits +no rules/);
  assert.equal(readLedger(root, ID).state, "merged");
});

test("a land resumed after its picks does not check the subjects again", () => {
  const { path, shas } = buildSubjects(LONG_SUBJECT);
  execLedger({ path, gated: shas[0] });
  execWrites();
  const pre = head();
  landKilledAt(" cherry-pick [0-9a-f]", "after");
  assert.equal(chainSince(pre).length, 1, "the pick is on main");
  // The rules arrive now (kept out of git's status so main reads as the land left it).
  git(root, "update-index", "--skip-worktree", ".agentry/workflow.json");
  setSpec({ ...SPEC, ...RULES });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.doesNotMatch(res.stdout, /commits/);
  assert.equal(readLedger(root, ID).state, "merged");
});

// --- the type hint (field 91) ------------------------------------------------------------------------

const PATTERN = { commits: { subjectPattern: "^(feat|fix|docs)(\\(.+\\))?: " } };
const ART_HINT = (n) =>
  `type "art" is used ${n} times on main: add it to commits.subjectPattern? "^(feat|fix|docs|art)(\\\\(.+\\\\))?: "`;

test("a subject failing subjectPattern on a type main uses says so with the widened pattern, in the preflight and the land", () => {
  commitSpec({ ...SPEC, ...PATTERN });
  for (let i = 0; i < 2; i++) commitFile(root, `art${i}.txt`, `${i}\n`, `art: sprite ${i}`);
  const { path, shas } = buildSubjects("art: new sprite");
  execLedger({ path, gated: shas[0] });
  const pf = merge(ID, "--preflight");
  assert.equal(pf.status, 1, out(pf));
  const line = `✗ commits ${shas[0].slice(0, 7)} "art: new sprite": subject does not match commits.subjectPattern; ${ART_HINT(2)}`;
  assert.ok(pf.stdout.includes(line), out(pf));
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.ok(res.stdout.includes(line), out(res));
  // The pattern the hint gives, pasted, lets the land go through.
  const widened = JSON.parse(ART_HINT(2).split("? ")[1]);
  commitSpec({ ...SPEC, commits: { subjectPattern: widened } });
  execLedger({ path, gated: shas[0] });
  assert.equal(merge(ID, "--preflight").status, 0);
});

test("the hint never names a type main does not use: the line is as before", () => {
  commitSpec({ ...SPEC, ...PATTERN });
  const { path, shas } = buildSubjects("art: new sprite");
  execLedger({ path, gated: shas[0] });
  const pf = merge(ID, "--preflight");
  assert.equal(pf.status, 1, out(pf));
  assert.match(
    pf.stdout,
    /✗ commits +[0-9a-f]{7} "art: new sprite": subject does not match commits\.subjectPattern\n/,
  );
  assert.doesNotMatch(pf.stdout, /is used|add it to/);
});

// --- a merge commit that brings in another lane's branch (field 91) ----------------------------------

/** T2's lane in `state`, its branch with one commit; T1's branch merges it. Returns T1's merge sha. */
function mergeOfT2(state) {
  openLane("T2", state);
  const t2 = create(root, { id: "T2", base: "main" });
  commitFile(t2.path, "src/t2.txt", "t2\n", "feat: t2");
  const { path } = build({ "src/a.txt": "a\n" });
  git(path, "merge", "-q", "--no-ff", "-m", "Merge T2", "agentry/T2");
  execLedger({ path, gated: git(path, "rev-parse", "HEAD") });
  return git(path, "rev-parse", "HEAD");
}

test("a merge commit that brings in an open lane's branch names it: land it first, then rebase", () => {
  const sha = mergeOfT2("verified");
  const line = `merge ${sha.slice(0, 7)} brings in T2's branch: land T2 first (lane merge T2), then lane exec rebase T1`;
  const pf = merge(ID, "--preflight");
  assert.equal(pf.status, 1, out(pf));
  assert.ok(pf.stdout.includes(line), out(pf));
  assert.doesNotMatch(pf.stdout, /ask the builder to rebase/);
  const pre = head();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.ok(res.stdout.includes(line), out(res));
  assert.match(res.stdout, /next: lane merge T2\n?$/);
  assert.equal(head(), pre);
});

for (const state of ["merged", "closed"])
  test(`a merge commit that brings in a ${state} lane's branch keeps today's text`, () => {
    const sha = mergeOfT2(state);
    const pf = merge(ID, "--preflight");
    assert.equal(pf.status, 1, out(pf));
    assert.match(
      pf.stdout,
      /merge commit\(s\), which a cherry-pick cannot land: ask the builder to rebase onto main/,
    );
    assert.ok(pf.stdout.includes(sha.slice(0, 7)));
    assert.doesNotMatch(pf.stdout, /brings in|lane merge T2/);
  });

test("a merge of main, with another lane open, names no lane", () => {
  openLane("T2", "verified");
  commitFile(create(root, { id: "T2", base: "main" }).path, "src/t2.txt", "t2\n", "feat: t2");
  const { path } = build({ "src/a.txt": "a\n" });
  commitFile(root, "main.txt", "m\n");
  git(path, "merge", "-q", "--no-edit", "main");
  execLedger({ path, gated: git(path, "rev-parse", "HEAD") });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /cannot land: ask the builder to rebase onto main/);
  assert.doesNotMatch(res.stdout, /brings in|next: lane merge T2/);
});

test("a lane whose main branch reads as a git option is never passed to git, nor named", () => {
  const sha = mergeOfT2("verified");
  // `--output=<trap>` would have git rev-list write `<trap>..refs/heads/t2`: its folder is made ready.
  const trap = join(root, ".agentry", "run", "trap");
  mkdirSync(`${trap}..refs/heads`, { recursive: true });
  git(root, "branch", "t2", "agentry/T2");
  writeLedger(root, { ...readLedger(root, "T2"), branch: "t2", mainBranch: `--output=${trap}` });
  const pf = merge(ID, "--preflight");
  assert.equal(pf.status, 1, out(pf));
  assert.match(pf.stdout, /cannot land: ask the builder to rebase onto main/);
  assert.ok(pf.stdout.includes(sha.slice(0, 7)));
  assert.doesNotMatch(pf.stdout, /brings in/);
  assert.deepEqual(readdirSync(`${trap}..refs/heads`), [], "git wrote no file");
});

// ---- --branch: a branch's exact listed name, resolved as exec adopt resolves it (S40) ----

const refs = () => git(root, "for-each-ref", "--format=%(refname) %(objectname)");
/** A refused `--branch`: exit 2 naming `why`, no ledger written, no ref moved, main as it was. */
function refusedBranch(b, why, mode = ["--preflight"]) {
  const [before, pre] = [refs(), head()];
  const res = merge(ID, "--branch", b, ...mode);
  assert.equal(res.status, 2, `${JSON.stringify(b)}: ${out(res)}`);
  assert.ok(out(res).includes(why), `${JSON.stringify(b)}: ${out(res)}`);
  assert.equal(readLedger(root, ID), null, JSON.stringify(b));
  assert.equal(refs(), before, JSON.stringify(b));
  assert.equal(head(), pre);
  return res;
}
/** A hand worktree under `.claude/worktrees/<dir>` on a new branch `branch` with one commit. */
function handTree(dir, branch) {
  writeFileSync(join(root, ".git", "info", "exclude"), ".claude/\n");
  const path = join(root, ".claude", "worktrees", dir);
  mkdirSync(dirname(path), { recursive: true });
  git(root, "worktree", "add", "-q", "-b", branch, path, "main");
  commitFile(path, "src/a.txt", "a\n");
  return path;
}

test("--branch refuses a revision, refs/…, another case or a control character: nothing written, no ref moved", () => {
  build({ "src/a.txt": "a\n" });
  for (const b of [
    `${BRANCH}~0`,
    `${BRANCH}@{0}`,
    `${BRANCH}^{commit}`,
    `refs/heads/${BRANCH}`,
    "AGENTRY/T1",
    "agentry/t1",
    `${BRANCH}\n`,
    "",
  ])
    refusedBranch(b, `${b && !/\p{Cc}/u.test(b) ? b : JSON.stringify(b)} does not exist`);
  refusedBranch(`${BRANCH}~0`, `${BRANCH}~0 does not exist`, ["--message", "docs(board): land T1"]);
});

test("--branch refuses case twins (packed feat/x, loose feat/X) by either spelling, nothing written", () => {
  git(root, "checkout", "-q", "-b", "feat/x");
  commitFile(root, "decoy.txt", "decoy\n", "feat: decoy on packed feat/x");
  git(root, "checkout", "-q", "main");
  git(root, "pack-refs", "--all");
  git(root, "checkout", "-q", "-b", "feat/X");
  commitFile(root, "src/a.txt", "a\n", "feat: on loose feat/X");
  git(root, "checkout", "-q", "main");
  for (const [b, other] of [
    ["feat/x", "feat/X"],
    ["feat/X", "feat/x"],
  ]) {
    refusedBranch(b, `${b} has a case twin ${other}: rename one first`);
    refusedBranch(b, `${b} has a case twin ${other}: rename one first`, [
      "--message",
      "docs(board): land T1",
    ]);
  }
});

test("a stopped exec lane whose branch has a case twin is refused, its ledger as it was", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  writeLedger(root, { ...readLedger(root, ID), state: "stopped" });
  git(root, "pack-refs", "--all");
  git(root, "branch", "agentry/t1", "main");
  const [before, pre, ledger] = [refs(), head(), readLedger(root, ID)];
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /agentry\/T1 has a case twin agentry\/t1: rename one first/);
  assert.deepEqual(
    [readLedger(root, ID).state, readLedger(root, ID).origin],
    [ledger.state, ledger.origin],
  );
  assert.deepEqual([refs(), head()], [before, pre]);
});

test("--branch refuses a branch whose worktree is on a spelling no branch is named, by either spelling", () => {
  const path = handTree("agent-x", "feature/x");
  // What `git checkout FEATURE/X` writes on a case-insensitive filesystem, on any filesystem.
  git(path, "symbolic-ref", "HEAD", "refs/heads/FEATURE/X");
  refusedBranch(
    "feature/x",
    `${path} is on FEATURE/X, which no branch is named: check it out by its exact name`,
  );
  refusedBranch("FEATURE/X", "FEATURE/X does not exist");
});

test("--branch on a worktree's branch with no commits yet says so, nothing written", () => {
  writeFileSync(join(root, ".git", "info", "exclude"), ".claude/\n");
  const path = join(root, ".claude", "worktrees", "agent-z");
  mkdirSync(dirname(path), { recursive: true });
  git(root, "worktree", "add", "-q", "--detach", path, "main");
  git(path, "symbolic-ref", "HEAD", "refs/heads/worktree-agent-z");
  const res = refusedBranch("worktree-agent-z", "worktree-agent-z has no commits yet");
  assert.doesNotMatch(out(res), /check it out by its exact name/);
});

test("--branch by its exact name adopts at the listed tip, and no output names git branch -D", () => {
  const path = handTree("agent-1", "feature/x");
  const tip = git(root, "rev-parse", "refs/heads/feature/x");
  const pf = merge(ID, "--branch", "feature/x", "--preflight");
  assert.equal(pf.status, 0, out(pf));
  const ledger = readLedger(root, ID);
  assert.deepEqual(
    [ledger.branch, ledger.worktree, ledger.base],
    ["feature/x", path, git(root, "merge-base", "main", tip)],
  );
  const outputs = [pf, mustLand(), merge(ID, "--cleanup")].map(out);
  assert.equal(git(root, "branch", "--list", "feature/x"), "");
  for (const text of outputs) assert.doesNotMatch(text, /branch -D/);
});

// ---- every call re-resolves the ledger's branch from the branch list (R1d-47 r3 N1–N4) ----

/** A hand branch `feat/x` adopted at preflight, then packed, then a loose twin `feat/X` with its own commit. */
function twinAfterAdopt() {
  git(root, "checkout", "-q", "-b", "feat/x");
  commitFile(root, "one.txt", "lower\n", "feat: lower x (the adopted one)");
  git(root, "checkout", "-q", "main");
  assert.equal(merge(ID, "--branch", "feat/x", "--preflight").status, 0);
  git(root, "pack-refs", "--all");
  git(root, "checkout", "-q", "-b", "feat/X");
  commitFile(root, "two.txt", "upper\n", "feat: upper X (the twin)");
  git(root, "checkout", "-q", "main");
}
/** A land that must be refused naming `why`, with main, the refs and the ledger as they were. */
function refusedLand(why, ...args) {
  const [before, pre, ledger] = [refs(), head(), readLedger(root, ID)];
  const res = merge(ID, ...args, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.ok(out(res).includes(why), out(res));
  assert.deepEqual([refs(), head()], [before, pre]);
  assert.deepEqual(readLedger(root, ID), ledger);
}

test("a case twin made after the adopt is refused on the land with --branch: its commit never lands", () => {
  twinAfterAdopt();
  refusedLand("feat/x has a case twin feat/X: rename one first", "--branch", "feat/x");
  assert.doesNotMatch(git(root, "log", "--format=%s", "main"), /upper X/);
});

test("a case twin made after the adopt is refused on a land with no --branch too", () => {
  twinAfterAdopt();
  refusedLand("feat/x has a case twin feat/X: rename one first");
  assert.doesNotMatch(git(root, "log", "--format=%s", "main"), /upper X/);
});

test("a verified exec lane whose branch gained a loose case twin is refused: the twin's decoy never lands", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  git(root, "pack-refs", "--all");
  git(root, "branch", "agentry/t1", "main");
  const decoy = join(root, ".agentry", "run", "decoy");
  git(root, "worktree", "add", "-q", decoy, "agentry/t1");
  commitFile(decoy, "decoy.txt", "decoy\n", "feat: decoy on twin agentry/t1");
  git(root, "worktree", "remove", "--force", decoy);
  for (const args of [["--branch", BRANCH], []])
    refusedLand("agentry/T1 has a case twin agentry/t1: rename one first", ...args);
  assert.doesNotMatch(git(root, "log", "--format=%s", "main"), /decoy/);
});

test("--branch refuses a branch whose worktree is mid-rebase on a spelling no branch is named", () => {
  const path = handTree("agent-y", "feature/y");
  commitFile(root, "src/a.txt", "main\n", "feat: a on main");
  // A rebase that stops on a conflict, its HEAD detached; its head-name is what `git checkout FEATURE/Y`
  // then `git rebase main` writes on a case-insensitive filesystem.
  const rebase = spawnSync("git", ["-C", path, "rebase", "main"], {
    encoding: "utf8",
    env: gitEnv,
  });
  assert.notEqual(rebase.status, 0, "the rebase stops on its conflict");
  const headName = join(git(path, "rev-parse", "--absolute-git-dir"), "rebase-merge", "head-name");
  writeFileSync(headName, "refs/heads/FEATURE/Y\n");
  refusedBranch(
    "feature/y",
    `${path} is on FEATURE/Y, which no branch is named: check it out by its exact name`,
  );
});

test("--cleanup deletes the branch at its listed tip, and keeps one that gained a case twin", () => {
  git(root, "checkout", "-q", "-b", "feat/x");
  commitFile(root, "src/a.txt", "a\n", "feat: a");
  git(root, "checkout", "-q", "main");
  mustLand("--branch", "feat/x");
  git(root, "pack-refs", "--all");
  git(root, "branch", "feat/X", "main");
  const before = refs();
  const kept = merge(ID, "--cleanup");
  assert.equal(kept.status, 1, out(kept));
  assert.match(out(kept), /feat\/x has a case twin feat\/X: rename one first/);
  assert.equal(refs(), before, "neither spelling was deleted");
  git(root, "branch", "-D", "feat/X");
  const gone = merge(ID, "--cleanup");
  assert.equal(gone.status, 0, out(gone));
  assert.equal(git(root, "branch", "--list", "feat/x"), "");
});

// ---- every read after ledgerStep is at the tip it listed (S50, R1d-47 r5 N8, N9) ----

/** `lane merge <args>` with a `git` on PATH that, right after ledgerStep's `check-ref-format` of the
 *  ledger's branch (the branch list is read by then), packs the refs and makes the loose case twin
 *  `agentry/t1` at `at`: a twin made mid-call, which a read by name opens on a case-insensitive filesystem. */
function mergeWithTwinAfterLedgerStep(at, ...args) {
  const dir = join(home, "twin-shim");
  mkdirSync(dir, { recursive: true });
  const mark = join(dir, "mark");
  writeFileSync(mark, "");
  writeFileSync(
    join(dir, "git"),
    `#!/bin/bash
"${REAL_GIT}" "$@"; st=$?
if [ -f "${mark}" ] && [[ "$*" =~ $TWIN_ON ]]; then
  rm -f "${mark}"
  "${REAL_GIT}" -C "${root}" pack-refs --all
  "${REAL_GIT}" -C "${root}" update-ref refs/heads/agentry/t1 ${at}
fi
exit $st
`,
  );
  chmodSync(join(dir, "git"), 0o755);
  const env = {
    ...gitEnv,
    HOME: home,
    NO_COLOR: "1",
    PATH: `${dir}:${process.env.PATH}`,
    TWIN_ON: `check-ref-format refs/heads/${BRANCH}$`,
  };
  const res = spawnSync("node", [LANE, "merge", ...args, "--root", root], {
    encoding: "utf8",
    env,
  });
  assert.equal(existsSync(mark), false, "the twin was never made");
  return res;
}
/** A commit on main's tip changing only `file`, taken off main again: the twin's decoy. */
function decoyCommit(file) {
  commitFile(root, file, "decoy\n", "feat: decoy on the twin");
  const sha = head();
  git(root, "reset", "-q", "--hard", "HEAD~1");
  return sha;
}

test("the preflight's gate row reads the listed tip: a twin made after ledgerStep never picks the tier", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  const res = mergeWithTwinAfterLedgerStep(decoyCommit("docs/x.md"), ID, "--preflight");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /gate +full would run/);
  assert.doesNotMatch(res.stdout, /docs would run/);
});

test("the land checks its picks against main and records merge.tip at the listed tip, never the twin's", () => {
  commitSpec({ ...SPEC, guard: { allow: ["NOTES.md"] } });
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  // The twin's decoy adds NOTES.md, which is the owner's untracked guard.allow file on main: planned from
  // the twin, the land would refuse it as a pick that runs into what main carries.
  const decoy = decoyCommit("NOTES.md");
  writeFileSync(join(root, "NOTES.md"), "mine\n");
  const res = mergeWithTwinAfterLedgerStep(decoy, ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.equal(readLedger(root, ID).merge.tip, shas[0]);
  assert.doesNotMatch(git(root, "log", "--format=%s", "main"), /decoy/);
  assert.equal(readFileSync(join(root, "NOTES.md"), "utf8"), "mine\n");
});

test("--check refuses a ledger branch with a case twin, by its listed name: nothing recorded", () => {
  withChecklist();
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  git(root, "pack-refs", "--all");
  git(root, "branch", "agentry/t1", "main");
  const ledger = readLedger(root, ID);
  const res = merge(ID, "--check", "repo-merge=pass");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /agentry\/T1 has a case twin agentry\/t1: rename one first/);
  assert.deepEqual(readLedger(root, ID), ledger);
  git(root, "branch", "-D", "agentry/t1");
  assert.equal(merge(ID, "--check", "repo-merge=pass").status, 0);
  assert.equal(readLedger(root, ID).checks["repo-merge"].tip, shas[0]);
});

// --- deps before the picks (field 105) --------------------------------------------------------------

const DEPS_SPEC = {
  ...SPEC,
  kinds: {
    ...SPEC.kinds,
    task: {
      ...SPEC.kinds.task,
      fields: {
        ...SPEC.kinds.task.fields,
        deps: { column: "Deps", type: "list", ref: "task" },
      },
    },
  },
  rules: [...SPEC.rules, { rule: "deps-done", kind: "task", field: "deps" }],
};
// T1 (the lane) waits on T2 and T4; T3 is active and waits on T2: a problem of its own, not the land's.
const depsBoard = (t1) => `# Merge

## Sprints

| Sprint | Status |
| ------ | ------ |
| S1     | doing  |

## Tasks

| Task | Sprint | Status | Verdict | Commit | Deps |
| ---- | ------ | ------ | ------- | ------ | ---- |
| T1   | S1     | verify | PASS    |        | ${t1} |
| T2   | S1     | todo   |         |        |      |
| T3   | S1     | doing  |         |        | T2   |
| T4   | S1     | done   |         |        |      |
`;
function commitDeps(t1) {
  setSpec(DEPS_SPEC);
  writeFileSync(join(root, "plan", "BOARD.md"), depsBoard(t1));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "deps board");
}

test("a land whose item would be done with a dependency open is refused before any pick, with the board set line", () => {
  commitDeps("T2, T4");
  const { path, shas } = buildSubjects("feat: a");
  execLedger({ path, gated: shas[0] });
  const [pre, ledger] = [head(), ledgerBytes()];
  const pf = merge(ID, "--preflight");
  assert.equal(pf.status, 1, out(pf));
  assert.match(pf.stdout, /✗ deps +task T1 would be done, but depends on T2 \(task, todo\)/);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.match(res.stdout, /✗ deps +task T1 would be done, but depends on T2 \(task, todo\)/);
  assert.match(res.stdout, /agentry board set task T1 deps=T4 --apply/);
  assert.doesNotMatch(res.stdout, /✓ land|picked/);
  assert.equal(head(), pre);
  assert.equal(status(), "");
  assert.equal(ledgerBytes(), ledger);
  assert.equal(readLedger(root, ID).merge, undefined, "no merge record");
});

test("after the dependency is dropped the land goes through; a deps problem of another item does not stop it", () => {
  commitDeps("T4");
  const { path, shas } = buildSubjects("feat: a");
  execLedger({ path, gated: shas[0] });
  const pf = merge(ID, "--preflight");
  assert.equal(pf.status, 0, out(pf));
  assert.match(pf.stdout, /✓ deps +task T1 has no open dependency/);
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(board(), /\| T1 +\| S1 +\| done /);
});
