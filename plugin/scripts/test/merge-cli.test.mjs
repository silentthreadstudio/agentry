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
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { create } from "../lib/lane/worktree.mjs";
import { read as readLedger, write as writeLedger } from "../lib/process/ledger.mjs";
import { commitFile, git, gitEnv } from "./git-repo.mjs";

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
    command: ["node", "gate.mjs", "full"],
    quick: { command: ["node", "gate.mjs", "quick"], only: ["docs/**"] },
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
  writeFileSync(join(root, ".agentry", "process.json"), `${JSON.stringify(spec, null, 2)}\n`);
}
function commitSpec(spec) {
  setSpec(spec);
  git(root, "add", ".agentry/process.json");
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

/** An exec ledger for T1, verified, with a green full worktree gate on `gated` (a commit SHA). */
function execLedger({ path, gated }) {
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
            tier: "full",
            commit: gated,
            tree: git(root, "rev-parse", `${gated}^{tree}`),
            exit: 0,
            cleanBefore: true,
            cleanAfter: true,
            log: "/dev/null",
            seconds: 1,
            at: "2026-10-31T00:00:00.000Z",
          },
        ]
      : [],
    checks: {},
    usedMemories: [],
    state: "verified",
    next: "",
  });
}

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
  assert.match(res.stdout, /full: src\/a\.txt is outside the quick tier's "only" globs/);
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

test("the gate is skipped only on a green full worktree gate whose tree is main's after the land", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  execLedger({ path, gated: shas[0] });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, new RegExp(`skipped: gate on ${shas[0].slice(0, 7)}, tree identical`));
  assert.equal(readLedger(root, ID).gates.filter((g) => g.where === "main").length, 0);
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

test("a docs-only change runs the quick tier and says why", () => {
  build({ "docs/guide.md": "words\n" });
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /quick ran on main: exit 0/);
  assert.match(res.stdout, /quick: all 1 changed file\(s\) match the quick tier's "only"/);
  const log = readLedger(root, ID).gates.at(-1).log;
  assert.match(readFileSync(log, "utf8"), /gate tier quick/);
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

test("--drop-carry with nothing set aside is refused", () => {
  build({ "src/a.txt": "a\n" });
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1", "--drop-carry");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /--drop-carry: the ledger holds no set-aside board writes/);
});

// R1b-5 fix 5: a carry that no longer applies used to be dropped on the next run, silently.
test("a carry that no longer applies blocks every rerun until --drop-carry, which keeps its patch", () => {
  const { path, shas } = build({ "src/a.txt": "a\n" });
  const t2 = "| T2   | S1     | todo   |         |         |";
  commitFile(
    path,
    "plan/BOARD.md",
    BOARD_MD.replace(t2, "| T2   | S1     | todo   | n/a     |         |"),
  );
  execLedger({ path, gated: shas[0] });
  execWrites();
  const first = merge(ID, "--message", "docs(board): land T1");
  assert.equal(first.status, 1, out(first));
  assert.match(first.stdout, /✗ record +exec's board writes do not apply on top of the picks/);
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

test("a board write that adds a finding is restored and stops; a rerun after main moved won't guess", () => {
  // A flagged task must land with a verdict the rule accepts; the fixture's T1 has "PASS" and this rule
  // asks for "SIGNED", so the done task gets a new flagged-needs-verdict finding no load check foresees.
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
  build({ "src/a.txt": "a\n" });
  const before = { board: board(), sprint: sprint() };
  const res = merge(ID, "--branch", BRANCH, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✗ record +board check: 1 new finding\(s\).*restored/);
  assert.match(res.stdout, /flagged-needs-verdict T1/);
  assert.deepEqual({ board: board(), sprint: sprint() }, before);
  assert.equal(status(), "");
  assert.equal(readLedger(root, ID).merge.step, "gated");

  // Fixed: the land resumes from the ledger, no second pick, no second gate run.
  commitSpec(SPEC);
  const picked = readLedger(root, ID).merge.landed;
  const again = merge(ID, "--message", "docs(board): land T1");
  assert.equal(again.status, 1, out(again)); // main moved (the spec commit): it does not resume
  assert.match(again.stdout, /main has moved since this land picked 1 commit\(s\) onto/);
  assert.match(again.stdout, /: not this land's/);
  assert.match(again.stdout, /next: show the owner git log --first-parent/);
  assert.deepEqual(readLedger(root, ID).merge.landed, picked);
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
