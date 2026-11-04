// Tests for `lane exec restart <id> [--carry]` (field 69) on temp git repos: the old lane's ledger and run
// files archived as `<id>.<n>`, its worktree removed and its branch kept as `agentry/<id>.<n>`, a fresh
// `agentry/<id>` cut from main with every `start` record; `--carry` picks the old commits and applies the
// uncommitted diff, stopping on a conflict in the new worktree, main untouched. Builders are simulated by
// writing in the worktree and its report file.
// Run: node --test plugin/scripts/test/exec-restart.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  name: "Restart",
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
const BOARD_MD = `# Restart

## Tasks

| Task | Status | Verdict |
| ---- | ------ | ------- |
| T1   | todo   |         |
| T2   | todo   |         |
| T3   | todo   |         |
`;
const TASKS_MD = `# Tasks

### T1 · Two steps

- **Owns:** \`one.txt\`, \`two.txt\`
- **Steps:**
  1. Write one.txt → owner OK
  2. Write two.txt
- **Acceptance:**
  - two.txt exists

### T2 · Another

- **Owns:** \`four.txt\`. Accept: four.txt exists.

### T3 · No steps

- **Owns:** \`three.txt\`, \`more.txt\`. Accept: three.txt exists.
`;

// A repo on main with the board committed; `.agentry/` committed too unless `untracked`.
function repo({ spec = SPEC, untracked = false } = {}) {
  const root = temp("restart-repo-");
  const home = temp("restart-home-");
  git(root, "init", "-q", "-b", "main");
  commitFile(root, ".gitignore", untracked ? ".agentry/\n*.secret\n" : ".agentry/run/\n*.secret\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  commitFile(root, "three.txt", "a\nb\nc\n");
  writeSpec(join(root, ".agentry"), spec);
  if (!untracked) {
    git(root, "add", ".agentry");
    git(root, "commit", "-q", "-m", "add the process files");
  }
  return { root, home };
}
const spawnLane = ({ root, home }, args) =>
  spawnSync("node", [LANE, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home },
  });
function lane(r, ...args) {
  const res = spawnLane(r, ["exec", ...args, "--json"]);
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* a refusal on stderr */
  }
  return { exit: res.status, json, stderr: res.stderr };
}
const processDir = (root) => join(root, ".agentry", "run", "process");
const ledgerFile = (root, id) => join(processDir(root), "ledger", `${id}.json`);
const ledgerOf = (root, id) => JSON.parse(readFileSync(ledgerFile(root, id), "utf8"));
const tipOf = (root, ref) => git(root, "rev-parse", ref);
const hasRef = (root, ref) =>
  spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", ref], { env: gitEnv })
    .status === 0;
// What main looks like: HEAD and `git status`, which a restart never changes.
const mainOf = (root) => [tipOf(root, "HEAD"), git(root, "status", "--porcelain")];

// T3 started; its builder commits three.txt, edits more.txt (untracked) and writes a report; then held.
function worked(r) {
  const out = lane(r, "start", "T3").json;
  commitFile(out.worktree, "three.txt", "a\nlane\nc\n", "feat: three");
  writeFileSync(join(out.worktree, "more.txt"), "half\n");
  writeFileSync(out.reportPath, "NEEDS_CONTEXT\nwhich file holds the key?\n");
  assert.equal(lane(r, "hold", "T3", "--for", "later", "--note", "start over").exit, 0);
  return out;
}

test("restart --carry archives the lane, cuts T3 from main and carries its commit and uncommitted file", () => {
  const r = repo();
  const old = worked(r);
  const oldLedger = readFileSync(ledgerFile(r.root, "T3"), "utf8");
  const main = mainOf(r.root);
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual(
    [res.json.step, res.json.next, res.json.state],
    ["restart", "build", "building"],
  );
  // The archive: the old ledger byte for byte, its run files with the report.
  assert.equal(readFileSync(ledgerFile(r.root, "T3.1"), "utf8"), oldLedger);
  const report = join(processDir(r.root), "runs", "T3.1", "r1-build.report.md");
  assert.match(readFileSync(report, "utf8"), /^NEEDS_CONTEXT/);
  // The new lane: cut from main, the old commit picked on top, the untracked file back.
  const ledger = ledgerOf(r.root, "T3");
  assert.equal(ledger.base, main[0]);
  assert.equal(ledger.restarted.from, "T3.1");
  assert.deepEqual(ledger.carried, { commits: 1, files: 1, report });
  assert.equal(tipOf(r.root, "agentry/T3^"), main[0]);
  assert.equal(git(r.root, "log", "-1", "--format=%s", "agentry/T3"), "feat: three");
  assert.equal(readFileSync(join(old.worktree, "three.txt"), "utf8"), "a\nlane\nc\n");
  assert.equal(readFileSync(join(old.worktree, "more.txt"), "utf8"), "half\n");
  // Every old commit is on the new branch: the old branch goes.
  assert.equal(hasRef(r.root, "refs/heads/agentry/T3.1"), false);
  assert.equal(ledger.restarted.branch, null);
  const brief = readFileSync(res.json.brief, "utf8");
  assert.ok(
    brief.includes(
      `## Carried work\n\nA previous builder's work is in the tree (1 commits, 1 files uncommitted). Its last report is ${report}: read it first.\n`,
    ),
    brief,
  );
  assert.deepEqual(mainOf(r.root), main, "main is untouched");
  // Every `start` record: the board snapshot and the process file's hash beside it.
  assert.ok(ledger.boardAtStart.paths.includes("plan/BOARD.md"));
  assert.match(ledger.boardAtStartHash, /^[0-9a-f]{64}$/);
  assert.equal(ledger.mainAtStart.head, main[0]);
});

test("restart without --carry starts clean and keeps the old branch as agentry/T3.1, its diff archived", () => {
  const r = repo();
  const old = worked(r);
  const oldTip = tipOf(r.root, "agentry/T3");
  const res = lane(r, "restart", "T3");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(tipOf(r.root, "agentry/T3.1"), oldTip);
  assert.equal(tipOf(r.root, "agentry/T3"), tipOf(r.root, "main"));
  assert.equal(git(old.worktree, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(old.worktree, "three.txt"), "utf8"), "a\nb\nc\n");
  const ledger = ledgerOf(r.root, "T3");
  assert.equal(ledger.carried, undefined);
  assert.equal(ledger.restarted.branch, "agentry/T3.1");
  assert.doesNotMatch(readFileSync(res.json.brief, "utf8"), /## Carried work/);
  const diff = join(processDir(r.root), "runs", "T3.1", "restart", "uncommitted.diff");
  assert.match(readFileSync(diff, "utf8"), /\+\+\+ b\/more\.txt/);
});

test("a carried commit that conflicts with main stops: exit 1, main untouched, markers only in the named file", () => {
  const r = repo();
  worked(r);
  const oldTip = tipOf(r.root, "agentry/T3");
  commitFile(r.root, "three.txt", "a\nmain\nc\n", "fix: three on main");
  const main = mainOf(r.root);
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 1, res.stderr);
  assert.match(res.json.conflict, /^[0-9a-f]{7} feat: three conflicts in three\.txt: resolve it/);
  assert.deepEqual(mainOf(r.root), main);
  const tree = res.json.worktree;
  assert.equal(git(tree, "diff", "--name-only", "--diff-filter=U"), "three.txt");
  assert.match(readFileSync(join(tree, "three.txt"), "utf8"), /<<<<<<< /);
  assert.equal(existsSync(join(tree, "more.txt")), false, "the diff waits for the pick");
  assert.equal(tipOf(r.root, "agentry/T3.1"), oldTip, "the old branch is kept");
  assert.equal(ledgerOf(r.root, "T3").restarted.branch, "agentry/T3.1");
  assert.match(
    readFileSync(res.json.brief, "utf8"),
    /The carry stopped: [0-9a-f]{7} feat: three conflicts in three\.txt/,
  );
});

test("an uncommitted edit that conflicts with main stops after the picks, markers only in that file", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  commitFile(out.worktree, "more.txt", "more\n", "feat: more");
  writeFileSync(join(out.worktree, "three.txt"), "a\nlane\nc\n");
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  commitFile(r.root, "three.txt", "a\nmain\nc\n", "fix: three on main");
  const main = mainOf(r.root);
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 1, res.stderr);
  assert.match(
    res.json.conflict,
    /^the uncommitted diff conflicts in three\.txt: resolve the markers/,
  );
  assert.deepEqual(mainOf(r.root), main);
  assert.equal(git(out.worktree, "diff", "--name-only", "--diff-filter=U"), "three.txt");
  assert.equal(git(r.root, "log", "-1", "--format=%s", "agentry/T3"), "feat: more");
});

test("a restart with a builder out is refused, nothing changed; a merged lane too", () => {
  const r = repo();
  lane(r, "start", "T3");
  const before = readFileSync(ledgerFile(r.root, "T3"), "utf8");
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /✗ lane exec restart T3: a builder is out: hold it first/);
  assert.equal(readFileSync(ledgerFile(r.root, "T3"), "utf8"), before);
  assert.equal(existsSync(ledgerFile(r.root, "T3.1")), false);
  assert.equal(hasRef(r.root, "refs/heads/agentry/T3.1"), false);
  writeFileSync(
    ledgerFile(r.root, "T3"),
    JSON.stringify({ ...JSON.parse(before), state: "merged", next: null }),
  );
  assert.match(lane(r, "restart", "T3").stderr, /T3 is merged: nothing to restart/);
});

test("restart is refused while another lane's picks are on main, before any write", () => {
  const r = repo();
  worked(r);
  const pre = tipOf(r.root, "HEAD");
  const sha = commitFile(r.root, "landed.txt", "x\n", "feat: a pick");
  writeFileSync(
    ledgerFile(r.root, "ZZ"),
    JSON.stringify({
      v: 1,
      id: "ZZ",
      state: "merging",
      worktree: "/gone",
      owned: [],
      merge: { preHead: pre, landed: [sha], step: "gating", at: new Date().toISOString() },
    }),
  );
  const before = readFileSync(ledgerFile(r.root, "T3"), "utf8");
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 2);
  assert.match(
    res.stderr,
    /main is mid-land \(ZZ, since \d\d:\d\d\): its picks may still roll back/,
  );
  assert.equal(readFileSync(ledgerFile(r.root, "T3"), "utf8"), before);
  assert.equal(existsSync(join(processDir(r.root), "runs", "T3", "restart")), false);
});

test("a worktree's ignored file outside cleanup.disposable refuses the restart; a disposable one goes", () => {
  const r = repo();
  const out = worked(r);
  writeFileSync(join(out.worktree, "keys.secret"), "x\n");
  const res = lane(r, "restart", "T3");
  assert.equal(res.exit, 2);
  assert.match(
    res.stderr,
    /holds 1 ignored file\(s\) a restart would delete \(keys\.secret\): copy what you need out/,
  );
  assert.ok(existsSync(join(out.worktree, "keys.secret")));
  writeSpec(join(r.root, ".agentry"), { ...SPEC, cleanup: { disposable: ["*.secret"] } });
  git(r.root, "commit", "-qam", "chore: secrets are disposable");
  const ok = lane(r, "restart", "T3");
  assert.equal(ok.exit, 0, ok.stderr);
  assert.equal(existsSync(join(out.worktree, "keys.secret")), false);
});

test("a held lane's restart keeps its holds[] in the archive, and a second restart never overwrites the first", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  commitFile(out.worktree, "one.txt", "one\n", "feat: one");
  writeFileSync(out.reportPath, "DONE\nadded one.txt\nused_memories: none\n");
  assert.equal(lane(r, "report", "T1").json.state, "held");
  assert.equal(lane(r, "resume", "T1", "--note", "OK").exit, 0);
  assert.equal(lane(r, "hold", "T1", "--for", "later").exit, 0);
  const held = ledgerOf(r.root, "T1");
  assert.equal(lane(r, "restart", "T1").exit, 0);
  const first = readFileSync(ledgerFile(r.root, "T1.1"), "utf8");
  assert.deepEqual(JSON.parse(first).holds, held.holds);
  assert.equal(JSON.parse(first).holds.length, 1);
  assert.equal(JSON.parse(first).hold.for, "later");

  assert.equal(lane(r, "hold", "T1", "--for", "later").exit, 0);
  const again = lane(r, "restart", "T1");
  assert.equal(again.exit, 0, again.stderr);
  assert.equal(ledgerOf(r.root, "T1").restarted.from, "T1.2");
  assert.equal(readFileSync(ledgerFile(r.root, "T1.1"), "utf8"), first);
  assert.ok(existsSync(ledgerFile(r.root, "T1.2")));
  assert.ok(hasRef(r.root, "refs/heads/agentry/T1.1") && hasRef(r.root, "refs/heads/agentry/T1.2"));
});

test("with .agentry/ untracked, start and restart warn once the process file changed while a lane runs", () => {
  const r = repo({ untracked: true });
  assert.equal(lane(r, "start", "T2").json.warning, undefined);
  worked(r);
  const file = join(r.root, ".agentry", "process.json");
  writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
  // T2 and T3 took their board paths from the old copy; the restarted T3 takes them from the new one.
  const line =
    "! .agentry/process.json changed while T2 run: its board paths are frozen into this lane as they are now";
  const restarted = lane(r, "restart", "T3");
  assert.equal(restarted.exit, 0, restarted.stderr);
  assert.ok(restarted.json.warning?.split("\n").includes(line), restarted.json.warning);
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  const t1 = lane(r, "start", "T1");
  assert.equal(t1.exit, 0, t1.stderr);
  assert.ok(t1.json.warning?.split("\n").includes(line), t1.json.warning);
});

// ---- a failure after the archive (R1d-23 r2 N1) --------------------------------------------------------

test("a restart whose board row is gone refuses before any write: the lane, its worktree and branch as they were", () => {
  const r = repo();
  const old = worked(r);
  commitFile(r.root, "plan/BOARD.md", BOARD_MD.replace(/^\| T3 .*\n/m, ""), "chore: drop T3 row");
  const before = {
    ledger: readFileSync(ledgerFile(r.root, "T3"), "utf8"),
    tip: tipOf(r.root, "agentry/T3"),
    status: git(old.worktree, "status", "--porcelain"),
  };
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /✗ lane exec restart T3: no task "T3" on the board; nothing written/);
  assert.deepEqual(
    {
      ledger: readFileSync(ledgerFile(r.root, "T3"), "utf8"),
      tip: tipOf(r.root, "agentry/T3"),
      status: git(old.worktree, "status", "--porcelain"),
    },
    before,
  );
  assert.equal(existsSync(ledgerFile(r.root, "T3.1")), false);
  assert.equal(existsSync(join(processDir(r.root), "runs", "T3", "restart")), false);
  assert.equal(hasRef(r.root, "refs/heads/agentry/T3.1"), false);
});

test(
  "a restart that fails after the archive stops (exit 1) naming the archive, the kept branch and the diff",
  {
    skip: process.getuid?.() === 0 && "root writes a read-only file",
  },
  () => {
    const r = repo();
    worked(r);
    const oldTip = tipOf(r.root, "agentry/T3");
    const board = join(r.root, "plan", "BOARD.md");
    chmodSync(board, 0o444); // the dispatched write fails once the carry is done
    const res = spawnLane(r, ["exec", "restart", "T3", "--carry"]);
    chmodSync(board, 0o644);
    const out = res.stdout + res.stderr;
    assert.equal(res.status, 1, out);
    const runs = join(processDir(r.root), "runs", "T3.1");
    const diff = join(runs, "restart", "uncommitted.diff");
    assert.ok(out.includes(ledgerFile(r.root, "T3.1")), out);
    assert.ok(
      out.includes(`its old work is on agentry/T3.1 and its uncommitted diff at ${diff}`),
      out,
    );
    assert.match(out, /but the restart stopped: .*→ fix that, then start it by hand/);
    assert.equal(tipOf(r.root, "agentry/T3.1"), oldTip, "the kept branch survives");
    assert.match(readFileSync(diff, "utf8"), /\+\+\+ b\/more\.txt/);
  },
);
