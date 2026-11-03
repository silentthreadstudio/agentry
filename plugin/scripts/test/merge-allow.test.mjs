// Tests for `lane merge` and the owner's uncommitted `guard.allow` files: the land sets them aside (recorded in
// the ledger first), lands, and puts them back; a stop or a rerun after a kill puts them back too; any other
// dirt still refuses; and a flagged item that no verifier read does not land. A new untracked `guard.allow`
// file and a file only `board add` / `board set --apply` changed are carried the same way; a stop that keeps
// them set aside names them.
// Run: node --test plugin/scripts/test/merge-allow.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
  gate: { command: ["node", "gate.mjs"] },
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
    merge: { allow: { files: ["docs/status.md"], patch, sha256, at: "2026-11-01T00:00:00.000Z" } },
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

test("a recorded board add is set aside, the land goes on, and the row is back, uncommitted", () => {
  build({ "src/a.txt": "a\n" });
  const add = addDecision();
  assert.equal(add.status, 0, add.stderr);
  assert.equal(at("plan/DECISIONS.md"), DECISIONS_ADDED);
  const res = land();
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, /clean but for recorded board writes/);
  assert.match(res.stdout, /plan\/DECISIONS\.md: written by board add decision/);
  assert.match(
    res.stdout,
    /✓ writes +1 board-write file\(s\) set aside, recorded in the ledger first/,
  );
  assert.match(res.stdout, /✓ writes +board writes are on main again, uncommitted, as they were/);
  assert.equal(status(), " M plan/DECISIONS.md");
  assert.equal(at("plan/DECISIONS.md"), DECISIONS_ADDED);
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n"), [
    "plan/BOARD.md",
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

test("a recorded board set merges by cell onto a picked change of the same file", () => {
  build({ "plan/DECISIONS.md": DECISIONS_MD.replace("Because", "Since") });
  const set = boardCli("set", "decision", "D1", "decision=Cited after all", "--apply");
  assert.equal(set.status, 0, set.stderr);
  const res = land();
  assert.equal(res.status, 0, out(res));
  assert.match(
    res.stdout,
    /✓ writes +board writes are on main again, uncommitted, set cell by cell/,
  );
  assert.equal(
    at("plan/DECISIONS.md"),
    DECISIONS_MD.replace("Because", "Since").replace("First", "Cited after all"),
  );
  assert.equal(status(), " M plan/DECISIONS.md");
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
      /allow: 1 file\(s\) set aside \(docs\/status\.md\) → restored by lane merge T1 --branch agentry\/T1 --message "docs\(board\): land T1"/,
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

test("a board add in the board file the land commits is put back next to the rows it was written beside", () => {
  build({ "src/a.txt": "a\n" });
  const add = boardCli("add", "task", "--fields", '{"id": "T3"}', "--apply");
  assert.equal(add.status, 0, add.stderr);
  const res = land();
  assert.equal(res.status, 0, out(res));
  assert.doesNotMatch(res.stdout, /! writes/);
  assert.match(res.stdout, /✓ writes +board writes are on main again, uncommitted, set row by row/);
  assert.equal(status(), " M plan/BOARD.md");
  assert.match(at("plan/BOARD.md"), /\| T1 +\| done .*\n\| T3 +\| todo/);
  assert.doesNotMatch(git(root, "show", "HEAD:plan/BOARD.md"), /T3/);
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
