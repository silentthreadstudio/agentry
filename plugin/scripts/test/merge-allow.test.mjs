// Tests for `lane merge` and the owner's uncommitted `guard.allow` files: the land sets them aside (recorded in
// the ledger first), lands, and puts them back; a stop or a rerun after a kill puts them back too; any other
// dirt still refuses; and a flagged item that no verifier read does not land.
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

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");
const ID = "T1";

const SPEC = {
  version: 1,
  name: "Allow",
  root: "plan",
  kinds: {
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
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
  writeFileSync(join(root, "docs", "status.md"), STATUS_MD);
  writeFileSync(join(root, "NOTES.md"), "notes\n");
  writeFileSync(join(root, "other.txt"), "other\n");
  mkdirSync(join(root, ".agentry"), { recursive: true });
  writeFileSync(join(root, ".agentry", "process.json"), `${JSON.stringify(SPEC, null, 2)}\n`);
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
  assert.match(out(res), /other\.txt: not a board file/);
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
