// Tests for `lane merge` and the owner's uncommitted `guard.allow` files: the land sets them aside (recorded in
// the ledger first), lands, and puts them back; a stop or a rerun after a kill puts them back too; any other
// dirt still refuses; and a flagged item that no verifier read does not land. A new untracked `guard.allow`
// file is carried the same way; a file only `board add` / `board set --apply` changed is set aside too, and
// carried into the board commit. A stop that keeps them set aside names them.
// Run: node --test plugin/scripts/test/merge-allow.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { heldRow, putBackAllow } from "../lib/lane/merge/aside.mjs";
import { mainRow } from "../lib/lane/merge/main-row.mjs";
import { commitStep } from "../lib/lane/merge/record.mjs";
import { create } from "../lib/lane/worktree.mjs";
import { read as readLedger, runDir, write as writeLedger } from "../lib/process/ledger.mjs";
import { loadSpec } from "../lib/process/read.mjs";
import { commitFile, git, gitEnv } from "./git-repo.mjs";
import { writeSpec } from "./spec-files.mjs";

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");
const BOARD = join(dirname(fileURLToPath(import.meta.url)), "..", "board.mjs");
const ID = "T1";

const SPEC = {
  version: 1,
  name: "Allow",
  root: "plan",
  kinds: {
    decision: {
      label: "Decision",
      at: { table: "DECISIONS.md", heading: "Decisions" },
      id: { column: "#" },
      fields: { decision: { column: "Decision" }, why: { column: "Why" } },
      create: {
        id: "ask",
        rows: [
          { in: "self", at: "end", cells: { "#": "{id}", Decision: "{decision}", Why: "{why}" } },
        ],
      },
    },
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      create: {
        id: "ask",
        rows: [{ in: "self", at: "end", cells: { Task: "{id}", Status: "todo" } }],
      },
      fields: {
        status: { column: "Status" },
        verdict: { column: "Verdict" },
        commit: { column: "Commit", type: "commits" },
        flag: { column: "Flag", type: "flag", mark: "x" },
      },
      status: {
        field: "status",
        values: { todo: "planned", doing: "active", verify: "active", done: "done" },
      },
    },
  },
  rules: [{ rule: "ids-unique" }, { rule: "status-known" }],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", built: "verify", failed: "doing", merged: "done" },
    write: { status: "status", verdict: "verdict", commit: "commit" },
  },
  gate: { tiers: [{ name: "full", command: ["node", "gate.mjs"] }] },
  guard: { allow: ["docs/**", "NOTES.md"] },
};
const BOARD_MD = `# Allow

## Tasks

| Task | Status | Verdict | Commit | Flag |
| ---- | ------ | ------- | ------ | ---- |
| T1   | verify | PASS    |        |      |
`;
const DECISIONS_MD = `# Allow

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | First | Because |
`;
const STATUS_MD = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
const GATE_JS = `import { existsSync } from "node:fs";
process.exit(existsSync("red.txt") ? 1 : 0);
`;

let root;
let home;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "allow-home-")));
  root = realpathSync(mkdtempSync(join(tmpdir(), "allow-repo-")));
  git(root, "init", "-q", "-b", "main");
  // commitStep commits in this process, with no gitEnv identity: the repo carries its own.
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, ".gitignore"), ".agentry/run/\n");
  writeFileSync(join(root, "gate.mjs"), GATE_JS);
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "plan", "BOARD.md"), BOARD_MD);
  writeFileSync(join(root, "plan", "DECISIONS.md"), DECISIONS_MD);
  writeFileSync(join(root, "docs", "status.md"), STATUS_MD);
  writeFileSync(join(root, "NOTES.md"), "notes\n");
  writeFileSync(join(root, "other.txt"), "other\n");
  mkdirSync(join(root, ".agentry"), { recursive: true });
  writeSpec(join(root, ".agentry"), SPEC);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const merge = (...args) =>
  spawnSync("node", [LANE, "merge", ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home, NO_COLOR: "1" },
  });
const out = (res) => res.stdout + res.stderr;
const land = () => merge(ID, "--branch", `agentry/${ID}`, "--message", "docs(board): land T1");
// `git status --porcelain` as it is: git-repo's helper trims, which would eat the first line's leading space.
const status = () =>
  spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
    env: gitEnv,
  }).stdout.trimEnd();
const at = (file) => readFileSync(join(root, file), "utf8");
const edit = (file, text) => writeFileSync(join(root, file), text);
// The task's branch with `files` committed on it (as `{ file: text }`).
function build(files) {
  const { path } = create(root, { id: ID, base: "main" });
  for (const [file, text] of Object.entries(files)) commitFile(path, file, text);
  return path;
}

test("an uncommitted guard.allow file no pick touches is set aside, the land goes on, and it is put back", () => {
  build({ "src/a.txt": "a\n" });
  edit("docs/status.md", STATUS_MD.replace("ten", "TEN"));
  edit("NOTES.md", "notes\nmore\n");
  const res = land();
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /clean but for guard\.allow edits/);
  assert.match(
    res.stdout,
    /✓ allow +2 guard\.allow file\(s\) set aside, recorded in the ledger first/,
  );
  assert.match(
    res.stdout,
    /✓ allow +guard\.allow edits are on main again, uncommitted, as they were/,
  );
  assert.equal(status(), " M NOTES.md\n M docs/status.md");
  assert.equal(at("docs/status.md"), STATUS_MD.replace("ten", "TEN"));
  assert.equal(at("NOTES.md"), "notes\nmore\n");
  const ledger = readLedger(root, ID);
  assert.equal(ledger.state, "merged");
  assert.equal(ledger.merge.allow, undefined);
  // the board commit holds the board and the picks only
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n"), [
    "plan/BOARD.md",
  ]);
});

test("a guard.allow file a picked commit touches is landed, and the owner's edit goes back on top", () => {
  build({ "docs/status.md": STATUS_MD.replace("one", "ONE") });
  edit("docs/status.md", STATUS_MD.replace("ten", "TEN"));
  const res = land();
  assert.equal(res.status, 0, out(res));
  assert.equal(at("docs/status.md"), STATUS_MD.replace("one", "ONE").replace("ten", "TEN"));
  assert.equal(status(), " M docs/status.md");
  assert.equal(
    git(root, "show", "HEAD~1:docs/status.md"),
    STATUS_MD.replace("one", "ONE").trimEnd(),
  );
});

test("an edit that cannot go back over the landed change is saved to a patch file and said, never lost", () => {
  build({ "docs/status.md": STATUS_MD.replace("one", "ONE") });
  edit("docs/status.md", STATUS_MD.replace("one", "uno"));
  const res = land();
  assert.equal(res.status, 0, out(res));
  assert.match(
    res.stdout,
    /! allow +guard\.allow edits were not put back \(docs\/status\.md\): they no longer apply/,
  );
  const file = /saved in (\S+merge-allow-1\.patch)/.exec(res.stdout)?.[1];
  assert.ok(file && existsSync(file), res.stdout);
  assert.match(readFileSync(file, "utf8"), /\+uno/);
  assert.equal(status(), "");
  assert.equal(readLedger(root, ID).merge.allow, undefined);
});

test("any other uncommitted change still refuses the land, and the allowed edit stays where it is", () => {
  build({ "src/a.txt": "a\n" });
  edit("docs/status.md", STATUS_MD.replace("ten", "TEN"));
  edit("other.txt", "changed\n");
  const pre = git(root, "rev-parse", "HEAD");
  const res = land();
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /main has 1 uncommitted change\(s\) the land cannot carry/);
  assert.match(out(res), /other\.txt: not a board file, not in guard\.allow/);
  assert.doesNotMatch(out(res), /status\.md/);
  assert.equal(git(root, "rev-parse", "HEAD"), pre);
  assert.equal(at("docs/status.md"), STATUS_MD.replace("ten", "TEN"));
});

test("a stop (a red gate) puts the owner's edit back and takes the picks off main", () => {
  build({ "red.txt": "fails the gate\n" });
  edit("docs/status.md", STATUS_MD.replace("ten", "TEN"));
  const pre = git(root, "rev-parse", "HEAD");
  const res = land();
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /✓ rollback main reset to/);
  assert.equal(git(root, "rev-parse", "HEAD"), pre);
  assert.equal(status(), " M docs/status.md");
  assert.equal(at("docs/status.md"), STATUS_MD.replace("ten", "TEN"));
  assert.equal(readLedger(root, ID).merge.allow, undefined);
});

test("a rerun after a kill puts back the edits the ledger holds before anything else", () => {
  const path = build({ "src/a.txt": "a\n" });
  edit("docs/status.md", STATUS_MD.replace("ten", "TEN"));
  const patch = git(root, "diff", "--binary", "HEAD", "--", "docs/status.md").concat("\n");
  const sha256 = createHash("sha256").update(patch).digest("hex");
  git(root, "restore", "--source=HEAD", "--staged", "--worktree", "--", "docs/status.md");
  assert.equal(status(), "");
  writeLedger(root, {
    v: 1,
    id: ID,
    kind: "task",
    contract: { file: "plan/TASKS.md", line: 1 },
    origin: "exec",
    mainBranch: "main",
    base: git(root, "rev-parse", "main"),
    worktree: path,
    branch: `agentry/${ID}`,
    mainAtStart: { head: git(root, "rev-parse", "main"), porcelain: [] },
    worktreesAtStart: [],
    rounds: [],
    gates: [],
    checks: {},
    usedMemories: [],
    state: "verified",
    next: "",
    merge: {
      allow: {
        enc: "bytes",
        files: ["docs/status.md"],
        patch,
        sha256,
        at: "2026-11-01T00:00:00.000Z",
      },
    },
  });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 0, out(res));
  assert.equal(at("docs/status.md"), STATUS_MD.replace("ten", "TEN"));
  assert.equal(status(), " M docs/status.md");
  assert.equal(readLedger(root, ID).merge.allow, undefined);
});

test("the preflight says which guard.allow files the land sets aside", () => {
  build({ "src/a.txt": "a\n" });
  edit("NOTES.md", "notes\nmore\n");
  const pf = merge(ID, "--branch", `agentry/${ID}`, "--preflight");
  assert.equal(pf.status, 0, out(pf));
  assert.match(
    pf.stdout,
    /NOTES\.md: uncommitted, in guard\.allow; set aside for the land, then put back/,
  );
  assert.equal(at("NOTES.md"), "notes\nmore\n");
});

test("a flagged item that no verifier read does not land", () => {
  const path = build({ "src/a.txt": "a\n" });
  const board = join(root, "plan", "BOARD.md");
  writeFileSync(board, readFileSync(board, "utf8").replace("|      |\n", "| x    |\n"));
  git(root, "commit", "-qam", "flag T1");
  writeLedger(root, {
    v: 1,
    id: ID,
    kind: "task",
    origin: "exec",
    mainBranch: "main",
    base: git(root, "rev-parse", "main"),
    worktree: path,
    branch: `agentry/${ID}`,
    mainAtStart: { head: git(root, "rev-parse", "main"), porcelain: [] },
    worktreesAtStart: [],
    rounds: [{ n: 1, step: "build", role: "build" }],
    gates: [],
    checks: {},
    usedMemories: [],
    state: "verified",
    next: "",
  });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /T1 is flagged on the board, but no verifier read it/);
});

// The board CLI in the main checkout: its writes are recorded, as the main-touched guard reads them.
const boardCli = (...args) =>
  spawnSync("node", [BOARD, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home, NO_COLOR: "1" },
  });
const addDecision = () =>
  boardCli(
    "add",
    "decision",
    "--fields",
    '{"id": "D2", "decision": "A night call", "why": "Dry"}',
    "--apply",
  );
const DECISIONS_ADDED = DECISIONS_MD.concat("| D2 | A night call | Dry |\n");

test("an untracked guard.allow file is set aside, the land goes on, and it is put back as it was", () => {
  build({ "src/a.txt": "a\n" });
  edit("docs/new.md", "a new note\n");
  const res = land();
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /clean but for guard\.allow edits/);
  assert.match(
    res.stdout,
    /✓ allow +1 guard\.allow file\(s\) set aside, recorded in the ledger first/,
  );
  assert.match(
    res.stdout,
    /✓ allow +guard\.allow edits are on main again, uncommitted, as they were/,
  );
  assert.equal(status(), "?? docs/new.md");
  assert.equal(at("docs/new.md"), "a new note\n");
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n"), [
    "plan/BOARD.md",
  ]);
  assert.equal(readLedger(root, ID).merge.allow, undefined);
});

test("a picked commit that adds the path of an untracked guard.allow file refuses the land before any pick", () => {
  build({ "docs/new.md": "from the branch\n" });
  edit("docs/new.md", "mine\n");
  const pre = git(root, "rev-parse", "HEAD");
  const res = land();
  assert.equal(res.status, 2, out(res));
  assert.match(
    out(res),
    /✗ main +docs\/new\.md: untracked on main and added by [0-9a-f]{7} → move it aside or commit it, then rerun/,
  );
  assert.equal(git(root, "rev-parse", "HEAD"), pre);
  assert.equal(at("docs/new.md"), "mine\n");
  assert.equal(readLedger(root, ID).merge, undefined);
});

test("an untracked file outside guard.allow still refuses, and the message says so", () => {
  build({ "src/a.txt": "a\n" });
  edit("docs/new.md", "allowed\n");
  edit("scratch.txt", "not allowed\n");
  const res = land();
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /main is not clean: 1 change\(s\) not in guard\.allow/);
  assert.match(out(res), /\?\? scratch\.txt/);
  assert.doesNotMatch(out(res), /docs\/new\.md/);
});

// Field 79: a recorded board write is the owner's board record, so it rides in the board commit.
test("a recorded board add is set aside for the picks and the gate, then carried into the board commit", () => {
  build({ "src/a.txt": "a\n" });
  const add = addDecision();
  assert.equal(add.status, 0, add.stderr);
  assert.equal(at("plan/DECISIONS.md"), DECISIONS_ADDED);
  const res = land();
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /clean but for recorded board writes/);
  assert.match(
    res.stdout,
    /plan\/DECISIONS\.md: written by board add decision D2, uncommitted; set aside for the land, then carried into the board commit/,
  );
  assert.match(
    res.stdout,
    /✓ writes +1 board-write file\(s\) set aside, recorded in the ledger first/,
  );
  assert.match(
    res.stdout,
    /✓ carry +plan\/DECISIONS\.md: your recorded board write, carried into the board commit/,
  );
  assert.equal(status(), "");
  assert.equal(git(root, "show", "HEAD:plan/DECISIONS.md"), DECISIONS_ADDED.trimEnd());
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n"), [
    "plan/BOARD.md",
    "plan/DECISIONS.md",
  ]);
  assert.equal(readLedger(root, ID).merge.writes, undefined);
});

test("a hand edit of a board file, alone or after a recorded write, still refuses", () => {
  build({ "src/a.txt": "a\n" });
  edit("plan/DECISIONS.md", DECISIONS_MD.replace("First", "Hand"));
  const hand = land();
  assert.equal(hand.status, 2, out(hand));
  assert.match(out(hand), /the land cannot carry/);
  git(root, "restore", "plan/DECISIONS.md");
  assert.equal(addDecision().status, 0);
  edit("plan/DECISIONS.md", DECISIONS_ADDED.replace("Dry", "Wet"));
  const after = land();
  assert.equal(after.status, 2, out(after));
  assert.match(out(after), /the land cannot carry/);
});

test("a picked commit that changes the file of a recorded board add refuses before any pick, naming both", () => {
  build({ "plan/DECISIONS.md": DECISIONS_MD.replace("Because", "Since") });
  assert.equal(addDecision().status, 0);
  const pre = git(root, "rev-parse", "HEAD");
  const res = land();
  assert.equal(res.status, 2, out(res));
  assert.match(
    out(res),
    /plan\/DECISIONS\.md: written on main by board add decision D2 and changed by [0-9a-f]{7}, which cannot merge by cell/,
  );
  assert.equal(git(root, "rev-parse", "HEAD"), pre);
  assert.equal(at("plan/DECISIONS.md"), DECISIONS_ADDED);
});

test("a recorded board set merges by cell onto a picked change of the same file, into the board commit", () => {
  build({ "plan/DECISIONS.md": DECISIONS_MD.replace("Because", "Since") });
  const set = boardCli("set", "decision", "D1", "decision=Cited after all", "--apply");
  assert.equal(set.status, 0, set.stderr);
  const res = land();
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /✓ carry +plan\/DECISIONS\.md: your recorded board write/);
  assert.equal(
    git(root, "show", "HEAD:plan/DECISIONS.md"),
    DECISIONS_MD.replace("Because", "Since").replace("First", "Cited after all").trimEnd(),
  );
  assert.equal(status(), "");
});

// A git on PATH that lets a cherry-pick stop but not be aborted: main is left mid-pick.
function stuckGit() {
  const dir = mkdtempSync(join(tmpdir(), "allow-shim-"));
  const real = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const shim = join(dir, "git");
  writeFileSync(
    shim,
    `#!/bin/sh\ncase "$*" in *"cherry-pick --abort"*) exit 1;; esac\nexec ${real} "$@"\n`,
    {
      mode: 0o755,
    },
  );
  return { dir, PATH: `${dir}:${process.env.PATH}` };
}

test("a pick that stops and cannot be aborted names the set-aside files and the command that restores them", () => {
  build({ "src/a.txt": "branch\n" });
  commitFile(root, "src/a.txt", "main\n");
  edit("docs/status.md", STATUS_MD.replace("ten", "TEN"));
  const shim = stuckGit();
  try {
    const res = spawnSync(
      "node",
      [
        LANE,
        "merge",
        ID,
        "--branch",
        `agentry/${ID}`,
        "--message",
        "docs(board): land T1",
        "--root",
        root,
      ],
      { encoding: "utf8", env: { ...gitEnv, HOME: home, NO_COLOR: "1", PATH: shim.PATH } },
    );
    assert.equal(res.status, 1, out(res));
    assert.match(res.stdout, /cherry-pick stopped/);
    assert.match(
      res.stdout,
      /allow: 1 file\(s\) set aside \(docs\/status\.md\) → restored by lane merge T1 --branch agentry\/T1 --message 'docs\(board\): land T1'/,
    );
    assert.ok(readLedger(root, ID).merge.allow);
  } finally {
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("a recovery stop that keeps the carry names the set-aside files and the command that restores them", () => {
  const path = build({ "src/a.txt": "a\n" });
  // git is in the middle of a cherry-pick that is not this land's
  git(root, "branch", "other");
  commitFile(root, "c.txt", "main\n");
  git(root, "checkout", "-q", "other");
  commitFile(root, "c.txt", "other\n");
  git(root, "checkout", "-q", "main");
  spawnSync("git", ["-C", root, "cherry-pick", "other"], { env: gitEnv });
  const patch = "diff --git a/NOTES.md b/NOTES.md\n";
  writeLedger(root, {
    v: 1,
    id: ID,
    kind: "task",
    contract: { file: "plan/TASKS.md", line: 1 },
    origin: "exec",
    mainBranch: "main",
    base: git(root, "rev-parse", "main"),
    worktree: path,
    branch: `agentry/${ID}`,
    mainAtStart: { head: git(root, "rev-parse", "main"), porcelain: [] },
    worktreesAtStart: [],
    rounds: [],
    gates: [],
    checks: {},
    usedMemories: [],
    state: "verified",
    next: "",
    merge: {
      allow: {
        enc: "bytes",
        files: ["NOTES.md", "docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md", "docs/e.md"],
        patch,
        sha256: createHash("sha256").update(patch).digest("hex"),
        at: "2026-11-01T00:00:00.000Z",
      },
    },
  });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 1, out(res));
  assert.match(
    res.stdout,
    /✗ recover +git is in the middle of a cherry-pick that is not this land's/,
  );
  assert.match(
    res.stdout,
    /allow: 6 file\(s\) set aside \(NOTES\.md, docs\/a\.md, docs\/b\.md, docs\/c\.md, docs\/d\.md, \+1\) → restored by lane merge T1 --message/,
  );
});

const decisionSet = (value) => boardCli("set", "decision", "D1", `decision=${value}`, "--apply");

test("a picked commit that changes the very cell a board set wrote refuses before any pick", () => {
  build({ "plan/DECISIONS.md": DECISIONS_MD.replace("First", "Branch") });
  assert.equal(decisionSet("Mine").status, 0);
  const pre = git(root, "rev-parse", "HEAD");
  const res = land();
  assert.equal(res.status, 2, out(res));
  assert.match(
    out(res),
    /plan\/DECISIONS\.md: written on main by board set decision D1 .* changed by [0-9a-f]{7}, which cannot merge by cell/,
  );
  assert.equal(git(root, "rev-parse", "HEAD"), pre);
  assert.equal(at("plan/DECISIONS.md"), DECISIONS_MD.replace("First", "Mine "));
});

test("a picked commit that deletes the row a board set wrote refuses before any pick", () => {
  build({ "plan/DECISIONS.md": DECISIONS_MD.replace("| D1 | First | Because |\n", "") });
  assert.equal(decisionSet("Mine").status, 0);
  const pre = git(root, "rev-parse", "HEAD");
  const res = land();
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /plan\/DECISIONS\.md: written on main by .* cannot merge by cell/);
  assert.equal(git(root, "rev-parse", "HEAD"), pre);
});

test("a board add in the board file the land commits goes into the board commit beside the landing row", () => {
  build({ "src/a.txt": "a\n" });
  const add = boardCli("add", "task", "--fields", '{"id": "T3"}', "--apply");
  assert.equal(add.status, 0, add.stderr);
  const res = land();
  assert.equal(res.status, 0, out(res));
  assert.doesNotMatch(res.stdout, /! writes/);
  assert.match(res.stdout, /✓ carry +plan\/BOARD\.md: your recorded board write/);
  assert.equal(status(), "");
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T1 +\| done .*\n\| T3 +\| todo/);
  assert.equal(readLedger(root, ID).merge.writes, undefined);
});

const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6e, 0xe3, 0x6f, 0x0a]);

test("a file that is not UTF-8 comes back byte for byte, new or edited", () => {
  build({ "src/a.txt": "a\n" });
  writeFileSync(join(root, "docs", "latin1.txt"), LATIN1);
  writeFileSync(join(root, "docs", "status.md"), Buffer.concat([Buffer.from(STATUS_MD), LATIN1]));
  const res = land();
  assert.equal(res.status, 0, out(res));
  assert.deepEqual(readFileSync(join(root, "docs", "latin1.txt")), LATIN1);
  assert.deepEqual(
    readFileSync(join(root, "docs", "status.md")),
    Buffer.concat([Buffer.from(STATUS_MD), LATIN1]),
  );
});

// --- a record written before the byte fix is never applied ------------------------------------

// A ledger for the task with `merge` in it, as a killed or stopped land left it.
function seedLedger(path, merge, extra = {}) {
  const head = git(root, "rev-parse", "main");
  writeLedger(root, {
    v: 1,
    id: ID,
    kind: "task",
    contract: { file: "plan/TASKS.md", line: 1 },
    origin: "exec",
    mainBranch: "main",
    base: head,
    worktree: path,
    branch: `agentry/${ID}`,
    mainAtStart: { head, porcelain: [] },
    worktreesAtStart: [],
    rounds: [],
    gates: [],
    checks: {},
    usedMemories: [],
    state: "verified",
    next: "",
    merge,
    ...extra,
  });
}
const ledgerBytes = () =>
  readFileSync(join(root, ".agentry", "run", "process", "ledger", `${ID}.json`));
// A patch that would apply to docs/status.md, then a CRLF and the two bytes of a UTF-8 é as latin1 characters
// (the latin1-era record that has no `enc`).
function oldPatch() {
  edit("docs/status.md", STATUS_MD.replace("ten", "TEN"));
  const diff = git(root, "diff", "--binary", "HEAD", "--", "docs/status.md");
  git(root, "restore", "--source=HEAD", "--staged", "--worktree", "--", "docs/status.md");
  return `${diff}\nkept\r\n\u00c3\u00a9\n`;
}
const oldRecord = (patch, enc) => ({
  ...(enc === undefined ? {} : { enc }),
  files: ["docs/status.md"],
  untracked: [],
  patch,
  sha256: createHash("sha256").update(patch).digest("hex"),
  at: "2026-11-01T00:00:00.000Z",
});
const REFUSAL =
  /✗ carry +recorded by an older version \(text patch\) → restore it by hand from (\S+merge-(?:allow|writes)-\d+\.patch)(?: or \S+\.latin1 \([^)]*\))?, then rerun with --drop-carry/;
const patchFiles = () => readdirSync(runDir(root, ID)).filter((n) => n.endsWith(".patch"));
const mainState = () => ({
  status: status(),
  index: git(root, "diff", "--cached", "--binary"),
  tree: git(root, "diff", "--binary"),
  status_md: at("docs/status.md"),
  head: git(root, "rev-parse", "HEAD"),
});

for (const [key, enc, patchName] of [
  ["allow", undefined, "merge-allow-1.patch"],
  ["allow", "text", "merge-allow-1.patch"],
  ["writes", undefined, "merge-writes-1.patch"],
]) {
  test(`a merge.${key} record with enc ${JSON.stringify(enc)} refuses, keeps its patch once, and --drop-carry drops it`, () => {
    const path = build({ "src/a.txt": "a\n" });
    const patch = oldPatch();
    seedLedger(path, { [key]: oldRecord(patch, enc) });
    const before = mainState();
    const res = merge(ID, "--message", "docs(board): land T1");
    assert.equal(res.status, 2, out(res));
    const kept = REFUSAL.exec(out(res))?.[1];
    assert.equal(kept, join(runDir(root, ID), patchName), out(res));
    // the é is two latin1 characters: either UTF-8 text or the raw bytes of a UTF-8 é, so both are kept
    assert.deepEqual(readFileSync(kept), Buffer.from(patch, "utf8"));
    assert.deepEqual(readFileSync(`${kept}.latin1`), Buffer.from(patch, "latin1")); // the é bytes and CRLF exactly
    assert.match(out(res), new RegExp(`${kept.replace(/\W/g, "\\$&")}\\.latin1`)); // the refusal names both
    assert.deepEqual(mainState(), before); // nothing applied, nothing set aside, nothing picked
    const record = readLedger(root, ID).merge[key];
    assert.equal(record.patch, patch); // the record stays in the ledger
    assert.equal(record.patchFile, kept);
    // a rerun names the same file and writes no second
    const again = merge(ID, "--message", "docs(board): land T1");
    assert.equal(again.status, 2, out(again));
    assert.equal(REFUSAL.exec(out(again))?.[1], kept);
    assert.deepEqual(patchFiles(), [patchName]);
    // dropped on the owner's call: the patch stays, the land goes on
    const drop = merge(ID, "--message", "docs(board): land T1", "--drop-carry");
    assert.equal(drop.status, 0, out(drop));
    assert.match(drop.stdout, /✓ carry +dropped .* recorded by an older version/);
    assert.equal(readLedger(root, ID).merge[key], undefined);
    assert.equal(readLedger(root, ID).state, "merged");
    assert.deepEqual(patchFiles(), [patchName]);
    assert.equal(at("docs/status.md"), STATUS_MD); // the dropped edit was not applied
  });
}

test("--drop-carry still refuses when the ledger holds no carry and no old record", () => {
  build({ "src/a.txt": "a\n" });
  const res = merge(
    ID,
    "--branch",
    `agentry/${ID}`,
    "--message",
    "docs(board): land T1",
    "--drop-carry",
  );
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), /--drop-carry: the ledger holds no set-aside board writes/);
});

test("an old record also stops commitStep, with nothing put back and the ledger not merged", () => {
  const path = build({ "src/a.txt": "a\n" });
  const patch = oldPatch();
  for (const files of [[], ["plan/BOARD.md"]]) {
    seedLedger(path, { allow: oldRecord(patch), step: "recording" });
    if (files.length > 0) edit("plan/BOARD.md", at("plan/BOARD.md").replace("PASS   ", "PASS ok"));
    const before = mainState();
    const lane = {
      root,
      id: ID,
      files,
      opts: { "--message": "docs(board): land T1" },
      ledger: readLedger(root, ID),
    };
    const rows = [];
    const stop = commitStep(lane, rows);
    assert.equal(stop.exit, 2);
    assert.equal(stop.keepCarry, true);
    assert.match(
      rows.at(-1).detail,
      /^recorded by an older version \(text patch\) → restore it by hand from \S+merge-allow-\d+\.patch or \S+\.latin1 \([^)]*\), then rerun with --drop-carry$/,
    );
    assert.equal(readLedger(root, ID).state, "verified"); // not merged: the rerun gets here again
    assert.ok(readLedger(root, ID).merge.allow);
    assert.equal(at("docs/status.md"), STATUS_MD);
    // the board commit itself is made (or nothing to commit), the working tree otherwise as it was
    if (files.length === 0) assert.deepEqual(mainState(), before);
    else assert.notEqual(git(root, "rev-parse", "HEAD"), before.head);
    git(root, "reset", "-q", "--hard", before.head);
    rmSync(runDir(root, ID), { recursive: true, force: true });
  }
});

test("an old record also stops recover, which has proven the board commit, and --drop-carry then finishes", () => {
  build({ "src/a.txt": "a\n" });
  const first = land();
  assert.equal(first.status, 0, out(first));
  // the ledger as a run killed right after its board commit left it
  const done = readLedger(root, ID);
  const sha = createHash("sha256").update(at("plan/BOARD.md")).digest("hex");
  const patch = oldPatch();
  const { boardCommit, cleaned, ...merged } = done.merge;
  seedLedger(done.worktree, {
    ...merged,
    step: "recording",
    record: { files: ["plan/BOARD.md"], sha256: { "plan/BOARD.md": sha } },
    allow: oldRecord(patch),
  });
  const before = mainState();
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.match(out(res), REFUSAL);
  assert.deepEqual(mainState(), before);
  assert.equal(readLedger(root, ID).state, "verified");
  assert.equal(readLedger(root, ID).merge.step, "recording");
  const drop = merge(ID, "--message", "docs(board): land T1", "--drop-carry");
  assert.equal(drop.status, 0, out(drop));
  assert.match(drop.stdout, /✓ recover +a killed run had made the board commit/);
  assert.equal(readLedger(root, ID).state, "merged");
  assert.equal(readLedger(root, ID).merge.allow, undefined);
});

// --- the hold line is one shell word per argument ---------------------------------------------------------

const ARGV = "console.log(JSON.stringify(process.argv.slice(2)));";
// The hold line's command for a land called with `opts`, split off its "lane merge " and run through sh
// with node printing the argv it got, in a scratch directory (a command substitution would make x there).
function heldCommand(
  opts,
  shell = "sh",
  merge = { allow: { enc: "bytes", files: ["docs/status.md"] } },
) {
  const lane = { id: ID, opts, ledger: { merge } };
  const line = heldRow(lane).more[0];
  const command = line.slice(line.indexOf("restored by ") + "restored by ".length);
  const dir = mkdtempSync(join(home, "quote-"));
  writeFileSync(join(home, "argv.mjs"), ARGV);
  const res = spawnSync(
    shell,
    ["-c", `node ${join(home, "argv.mjs")} ${command.slice("lane merge ".length)}`],
    {
      cwd: dir,
      encoding: "utf8",
    },
  );
  return {
    command,
    argv: JSON.parse(res.stdout),
    x: existsSync(join(dir, "x")),
    stderr: res.stderr,
  };
}

for (const [name, message, summary] of [
  [
    "a quote, a command substitution, a backtick and !",
    "it's $(touch x) `touch x` !",
    "$(touch x)",
  ],
  ["a newline and a tab", "one\ntwo\tthree", "a\tb"],
  ["an empty --summary", "docs(board): land T1", ""],
  ["a non-ASCII letter", "café", "é"],
  ["a leading dash", "-n", "-x"],
]) {
  test(`the hold line quotes ${name}, and sh gives the exact argv back`, () => {
    const opts = { "--branch": "agentry/T1", "--message": message, "--summary": summary };
    const run = heldCommand(opts);
    assert.deepEqual(
      run.argv,
      [ID, "--branch", "agentry/T1", "--message", message, "--summary", summary],
      run.stderr,
    );
    assert.equal(run.x, false);
    assert.ok(run.command.includes(`--message '`), run.command);
    assert.ok(run.command.includes(`--summary '`), run.command);
  });
}

test("a branch with a space is quoted, and a message of only safe characters prints bare", () => {
  const run = heldCommand({ "--branch": "my branch", "--message": "docs/board:land-T1_v1.0+x" });
  assert.deepEqual(run.argv, [
    ID,
    "--branch",
    "my branch",
    "--message",
    "docs/board:land-T1_v1.0+x",
  ]);
  assert.equal(
    run.command,
    "lane merge T1 --branch 'my branch' --message docs/board:land-T1_v1.0+x",
  );
});

// --- a record with one file in both cells and rows is a bug, never written -----------------------------------

test("a record with a file in both cells and rows throws before it writes anything", () => {
  const path = build({ "src/a.txt": "a\n" });
  const file = "plan/DECISIONS.md";
  const patch = git(root, "diff", "--binary", "HEAD", "--", file);
  const cells = [
    {
      kind: "decision",
      id: "D1",
      field: "decision",
      column: "Decision",
      file,
      from: "First",
      to: "Hand",
    },
  ];
  const rows = [
    {
      file,
      heading: "Decisions",
      header: ["#", "Decision", "Why"],
      idColumn: "#",
      key: "D2",
      prev: "D1",
      text: "| D2 | A | B |",
    },
  ];
  seedLedger(path, {
    writes: {
      enc: "bytes",
      files: [file],
      untracked: [],
      patch,
      sha256: createHash("sha256").update(patch).digest("hex"),
      cells,
      rows,
      cellsSha256: createHash("sha256")
        .update(JSON.stringify([cells, rows]))
        .digest("hex"),
      at: "2026-11-01T00:00:00.000Z",
    },
  });
  const [tree, ledger] = [mainState(), ledgerBytes()];
  const lane = {
    root,
    id: ID,
    opts: {},
    ledger: readLedger(root, ID),
    spec: loadSpec(join(root, ".agentry", "process.json"), { root }).spec,
  };
  const row = putBackAllow(lane);
  assert.equal(row.mark, "red");
  assert.equal(
    row.detail,
    "plan/DECISIONS.md has both cells and rows; this is a bug, nothing was written",
  );
  assert.deepEqual(mainState(), tree);
  assert.deepEqual(ledgerBytes(), ledger);
});

test("a both-kinds record beside a good one stops the land before the good one is put back", () => {
  const path = build({ "src/a.txt": "a\n" });
  edit("NOTES.md", "notes\nmine\n");
  const notes = git(root, "diff", "--binary", "HEAD", "--", "NOTES.md").concat("\n");
  git(root, "restore", "--source=HEAD", "--staged", "--worktree", "--", "NOTES.md");
  const file = "plan/DECISIONS.md";
  const cells = [
    {
      kind: "decision",
      id: "D1",
      field: "decision",
      column: "Decision",
      file,
      from: "First",
      to: "Hand",
    },
  ];
  const rows = [
    {
      file,
      heading: "Decisions",
      header: ["#", "Decision", "Why"],
      idColumn: "#",
      key: "D2",
      prev: "D1",
      text: "| D2 | A | B |",
    },
  ];
  const bad = {
    enc: "bytes",
    files: [file],
    untracked: [],
    patch: "x",
    sha256: createHash("sha256").update("x").digest("hex"),
    cells,
    rows,
    cellsSha256: createHash("sha256")
      .update(JSON.stringify([cells, rows]))
      .digest("hex"),
    at: "2026-11-01T00:00:00.000Z",
  };
  seedLedger(path, {
    allow: {
      enc: "bytes",
      files: ["NOTES.md"],
      untracked: [],
      patch: notes,
      sha256: createHash("sha256").update(notes).digest("hex"),
      at: "2026-11-01T00:00:00.000Z",
    },
    writes: bad,
  });
  const [tree, merged] = [mainState(), readLedger(root, ID).merge];
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.match(
    out(res),
    /✗ carry +plan\/DECISIONS\.md has both cells and rows; this is a bug, nothing was written/,
  );
  assert.doesNotMatch(out(res), /\bat .*\.mjs:\d+/);
  assert.deepEqual(mainState(), tree);
  assert.equal(at("NOTES.md"), "notes\n");
  assert.deepEqual(readLedger(root, ID).merge, merged); // the stop's next is the only ledger write
});

// --- the kept patch of an old record is the record's own text, whichever way it was made -------------------

// The record a version before the byte fix made: git's output decoded as UTF-8. Applied by hand from the kept
// file, it must give the edit back as the owner typed it.
test("a pre-byte-fix record with → é and · keeps its patch as UTF-8, and git apply restores the edit exactly", () => {
  const path = build({ "src/a.txt": "a\n" });
  const typed = STATUS_MD.replace("ten", "TEN → café · done");
  edit("docs/status.md", typed);
  const patch = spawnSync("git", ["-C", root, "diff", "--binary", "HEAD", "--", "docs/status.md"], {
    encoding: "utf8",
    env: gitEnv,
  }).stdout; // decoded as UTF-8, as the old worktree.git did
  git(root, "restore", "--source=HEAD", "--staged", "--worktree", "--", "docs/status.md");
  seedLedger(path, { allow: oldRecord(patch) });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  const kept = REFUSAL.exec(out(res))?.[1];
  assert.deepEqual(readFileSync(kept), Buffer.from(patch, "utf8"));
  const applied = spawnSync("git", ["-C", root, "apply", kept], { encoding: "utf8", env: gitEnv });
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(readFileSync(join(root, "docs", "status.md")), Buffer.from(typed, "utf8"));
});

test("a latin1-era record without enc keeps the raw bytes of a UTF-8 é, and git apply restores the edit exactly", () => {
  const path = build({ "src/a.txt": "a\n" });
  const typed = STATUS_MD.replace("ten", "café");
  edit("docs/status.md", typed);
  const raw = spawnSync("git", ["-C", root, "diff", "--binary", "HEAD", "--", "docs/status.md"], {
    env: gitEnv,
  }).stdout;
  git(root, "restore", "--source=HEAD", "--staged", "--worktree", "--", "docs/status.md");
  seedLedger(path, { allow: oldRecord(raw.toString("latin1")) }); // a latin1 string: one char per byte
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  const kept = `${REFUSAL.exec(out(res))?.[1]}.latin1`;
  assert.deepEqual(readFileSync(kept), raw);
  const applied = spawnSync("git", ["-C", root, "apply", kept], { encoding: "utf8", env: gitEnv });
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(readFileSync(join(root, "docs", "status.md")), Buffer.from(typed, "utf8"));
});

test("--drop-carry on an ambiguous old record keeps both files and names both", () => {
  const path = build({ "src/a.txt": "a\n" });
  const patch = oldPatch();
  seedLedger(path, { allow: oldRecord(patch) });
  const drop = merge(ID, "--message", "docs(board): land T1", "--drop-carry");
  assert.equal(drop.status, 0, out(drop));
  const file = join(runDir(root, ID), "merge-allow-1.patch");
  assert.deepEqual(readFileSync(file), Buffer.from(patch, "utf8"));
  assert.deepEqual(readFileSync(`${file}.latin1`), Buffer.from(patch, "latin1"));
  assert.ok(out(drop).includes(`${file} (UTF-8) and ${file}.latin1 (latin1 bytes)`), out(drop));
});

test("an old record without a character above U+00FF or in U+0080-U+00FF keeps one file only", () => {
  const path = build({ "src/a.txt": "a\n" });
  seedLedger(path, { allow: oldRecord("plain ascii\n") });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  assert.equal(REFUSAL.exec(out(res))?.[0].includes(".latin1"), false);
  assert.equal(
    readdirSync(runDir(root, ID)).some((n) => n.endsWith(".latin1")),
    false,
  );
});

test("a patchFile outside the run dir is neither read nor written; a new file is kept instead", () => {
  const path = build({ "src/a.txt": "a\n" });
  const patch = oldPatch();
  const outside = join(runDir(root, ID), "..", "..", "x");
  writeFileSync(outside, "not a patch\n");
  seedLedger(path, { allow: { ...oldRecord(patch), patchFile: "../../x" } });
  const res = merge(ID, "--message", "docs(board): land T1");
  assert.equal(res.status, 2, out(res));
  const kept = REFUSAL.exec(out(res))?.[1];
  assert.equal(kept, join(runDir(root, ID), "merge-allow-1.patch"), out(res));
  assert.deepEqual(readFileSync(kept), Buffer.from(patch, "utf8")); // the record's own patch, not the file there
  assert.equal(readFileSync(outside, "utf8"), "not a patch\n"); // not read, not written
  assert.equal(existsSync(`${outside}.latin1`), false);
  assert.equal(readLedger(root, ID).merge.allow.patchFile, kept); // the record is mended
});

test("a stop for an old record says to restore by hand; one for a both-kinds record says it is a bug", () => {
  const path = build({ "src/a.txt": "a\n" });
  seedLedger(path, { allow: oldRecord(oldPatch()) });
  const old = merge(ID, "--message", "docs(board): land T1");
  assert.equal(old.status, 2, out(old));
  assert.match(
    readLedger(root, ID).next,
    /^restore the kept patch by hand, then lane merge T1 .*--drop-carry$/,
  );
  // an old record beside a both-kinds one: the bug stops first, and says so, not "restore by hand"
  const file = "plan/DECISIONS.md";
  const cells = [
    {
      kind: "decision",
      id: "D1",
      field: "decision",
      column: "Decision",
      file,
      from: "First",
      to: "Hand",
    },
  ];
  const rows = [
    {
      file,
      heading: "Decisions",
      header: ["#", "Decision", "Why"],
      idColumn: "#",
      key: "D2",
      prev: "D1",
      text: "| D2 | A | B |",
    },
  ];
  const bad = {
    enc: "bytes",
    files: [file],
    untracked: [],
    patch: "x",
    sha256: createHash("sha256").update("x").digest("hex"),
    cells,
    rows,
    cellsSha256: createHash("sha256")
      .update(JSON.stringify([cells, rows]))
      .digest("hex"),
    at: "2026-11-01T00:00:00.000Z",
  };
  seedLedger(path, { allow: oldRecord(oldPatch()), writes: bad });
  const both = merge(ID, "--message", "docs(board): land T1");
  assert.equal(both.status, 2, out(both));
  assert.equal(readLedger(root, ID).next, "this is a bug: report it; nothing was changed");
});

test("the held line does not say restored by while a both-kinds record stands", () => {
  const file = "plan/DECISIONS.md";
  const both = {
    enc: "bytes",
    files: [file],
    patch: "x",
    cells: [{ file }],
    rows: [{ file }],
  };
  const line = heldRow({
    id: ID,
    opts: {},
    ledger: { merge: { allow: { enc: "bytes", files: ["a.md"] }, writes: both } },
  }).more[0];
  assert.doesNotMatch(line, /restored by/);
  assert.match(
    line,
    /2 file\(s\) set aside \(a\.md, plan\/DECISIONS\.md\) → not restored: this is a bug: report it/,
  );
});

test("with an old record beside a valid one, the held line names --drop-carry", () => {
  const run = heldCommand({ "--message": "docs(board): land T1" }, "sh", {
    allow: { enc: "bytes", files: ["docs/status.md"] },
    writes: { files: ["plan/DECISIONS.md"], patch: "x" },
  });
  assert.match(run.command, / --drop-carry$/);
  assert.equal(run.argv.at(-1), "--drop-carry");
});

// zsh expands a word that starts with = ; every shell must give the exact argv back.
for (const shell of ["sh", "bash", "zsh"]) {
  const present = spawnSync(shell, ["-c", "true"]).status === 0;
  test(
    `a word starting with = is quoted and round-trips through ${shell}`,
    { skip: !present },
    () => {
      for (const message of ["=ls", "=x", "a=b"]) {
        const run = heldCommand({ "--message": message, "--summary": "=ls" }, shell);
        assert.deepEqual(run.argv, [ID, "--message", message, "--summary", "=ls"], run.stderr);
        if (message.startsWith("="))
          assert.ok(run.command.includes(`--message '${message}'`), run.command);
        else assert.ok(run.command.includes(`--message ${message}`), run.command);
      }
    },
  );
}

test("scriptWrites never gives one file both cells and rows", () => {
  build({ "src/a.txt": "a\n" });
  const spec = loadSpec(join(root, ".agentry", "process.json"), { root }).spec;
  const writesOf = () => {
    const lane = { root, spec, ledger: { mainBranch: "main" } };
    mainRow(lane);
    return lane.writes;
  };
  const file = "plan/DECISIONS.md";
  const shapes = [];
  assert.equal(decisionSet("Cited").status, 0); // a cell only
  shapes.push(writesOf());
  git(root, "restore", file);
  assert.equal(addDecision().status, 0); // a row only
  shapes.push(writesOf());
  git(root, "restore", file);
  assert.equal(decisionSet("Cited").status, 0); // a cell and an added row
  assert.equal(addDecision().status, 0);
  shapes.push(writesOf());
  for (const writes of shapes) {
    assert.deepEqual(writes.files, [file]);
    const [inCells, inRows] = [writes.cells, writes.rows].map((list) =>
      list.some((e) => e.file === file),
    );
    assert.equal(inCells && inRows, false);
  }
  const [cellOnly, rowOnly, mixed] = shapes;
  assert.equal(cellOnly.cells.length > 0 && cellOnly.rows.length === 0, true);
  assert.equal(rowOnly.rows.length > 0 && rowOnly.cells.length === 0, true);
  assert.deepEqual([mixed.loose, mixed.cells], [[file], []]); // a cell edit makes the file loose: no rows either
});

// --- an exec cell and a board add in one file ----------------------------------------------------------------

const execWrite = () =>
  edit("plan/BOARD.md", at("plan/BOARD.md").replace("| PASS    |", "| FAIL    |"));
const addTask = () => boardCli("add", "task", "--fields", '{"id": "T3"}', "--apply");

test("an exec cell and a board add row in one BOARD.md refuse naming both, and set nothing aside", () => {
  build({ "src/a.txt": "a\n" });
  assert.equal(addTask().status, 0);
  execWrite();
  const before = mainState();
  const res = land();
  assert.equal(res.status, 2, out(res));
  assert.match(
    out(res),
    /plan\/BOARD\.md: a lifecycle write by T1 and a board add by board add task T3 share this file → land T1 first, or commit the added row/,
  );
  assert.deepEqual(mainState(), before);
  const ledger = readLedger(root, ID);
  assert.equal(ledger.merge?.allow, undefined);
  assert.equal(ledger.merge?.writes, undefined);
  assert.equal(ledger.merge?.carry, undefined);
});

test("the same two writes in two files land, both in the board commit", () => {
  build({ "src/a.txt": "a\n" });
  assert.equal(addDecision().status, 0);
  execWrite();
  const res = land();
  assert.equal(res.status, 0, out(res));
  assert.equal(status(), "");
  assert.equal(git(root, "show", "HEAD:plan/DECISIONS.md"), DECISIONS_ADDED.trimEnd());
  assert.match(git(root, "show", "HEAD:plan/BOARD.md"), /\| T1 +\| done +\| FAIL/);
  const ledger = readLedger(root, ID);
  assert.equal(ledger.merge.writes, undefined);
  assert.equal(ledger.merge.carry, undefined);
});
