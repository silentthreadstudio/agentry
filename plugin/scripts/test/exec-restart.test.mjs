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
| T4   | todo   |         |
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

### T4 · Three steps, two owner gates

- **Owns:** \`a.txt\`, \`b.txt\`, \`c.txt\`
- **Steps:**
  1. Write a.txt → owner OK
  2. Write b.txt → owner OK
  3. Write c.txt
- **Acceptance:**
  - c.txt exists
`;

// A repo on main with the board committed; `.agentry/` committed too unless `untracked`.
function repo({ spec = SPEC, untracked = false, board = BOARD_MD, prefix = "restart-repo-" } = {}) {
  const root = temp(prefix);
  const home = temp("restart-home-");
  git(root, "init", "-q", "-b", "main");
  commitFile(
    root,
    ".gitignore",
    `${untracked ? ".agentry/" : ".agentry/run/"}\n*.secret\nexports/\n`,
  );
  commitFile(root, "plan/BOARD.md", board);
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
// Where a restart archives lane `id` as number `n`: its ledger and its run dir.
const archiveFile = (root, id, n) =>
  join(processDir(root), "ledger", ".archive", `${id}.${n}.json`);
const archiveRuns = (root, id, n) => join(processDir(root), "runs", ".archive", `${id}.${n}`);
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
  assert.equal(readFileSync(archiveFile(r.root, "T3", 1), "utf8"), oldLedger);
  const report = join(archiveRuns(r.root, "T3", 1), "r1-build.report.md");
  assert.match(readFileSync(report, "utf8"), /^NEEDS_CONTEXT/);
  // The new lane: cut from main, the old commit picked on top, the untracked file back.
  const ledger = ledgerOf(r.root, "T3");
  assert.equal(ledger.base, main[0]);
  assert.equal(ledger.restarted.from, "T3.1");
  const diff = join(archiveRuns(r.root, "T3", 1), "restart", "uncommitted.diff");
  assert.deepEqual(ledger.carried, {
    rounds: { total: 1, builds: 1, verdicts: 0 },
    commits: 1,
    files: 1,
    report,
    applied: true,
    diff,
  });
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
      `## Carried work\n\nA previous builder's work is in the tree (1 commits, 1 files uncommitted). Its last report is ${report}: read it first. Its uncommitted changes are applied staged (\`git apply --3way\` stages them): \`git diff --cached\` shows them.\n`,
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
  const diff = join(archiveRuns(r.root, "T3", 1), "restart", "uncommitted.diff");
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
  const brief = readFileSync(res.json.brief, "utf8");
  assert.match(
    brief,
    /Resolve this first: [0-9a-f]{7} feat: three conflicts in three\.txt: resolve it, git cherry-pick --continue, then git apply --3way \S+\.diff\.\n/,
  );
  // The pick stopped before the diff: it is still to apply, never "applied staged" (r4 N4, probe P3), and
  // the step that applies it is named once, in the stop (R1d-23 r6 N13).
  assert.doesNotMatch(brief, /applied staged/);
  assert.match(brief, /Its uncommitted changes are not in the tree yet\. Resolve this first: /);
  assert.equal(brief.match(/git apply --3way/g).length, 1, brief);
  assert.equal(ledgerOf(r.root, "T3").carried.applied, false);
});

test("in a root holding a space, the carry's conflict and the brief quote the diff path, which pastes as is", () => {
  const r = repo({ prefix: "restart repo-" });
  worked(r);
  commitFile(r.root, "three.txt", "a\nmain\nc\n", "fix: three on main");
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 1, res.stderr);
  const diff = join(archiveRuns(r.root, "T3", 1), "restart", "uncommitted.diff");
  const apply = `git apply --3way '${diff}'`;
  assert.ok(res.json.conflict.includes(`then ${apply} in `), res.json.conflict);
  const brief = readFileSync(res.json.brief, "utf8");
  assert.ok(brief.includes(`then ${apply}.`), brief);
  assert.equal(brief.match(/git apply --3way/g).length, 1, brief);
  // The builder resolves the pick, then pastes the step as the stop prints it.
  const tree = res.json.worktree;
  writeFileSync(join(tree, "three.txt"), "a\nlane\nc\n");
  git(tree, "add", "three.txt");
  git(tree, "-c", "core.editor=true", "cherry-pick", "--continue");
  const pasted = spawnSync("sh", ["-c", apply], { cwd: tree, encoding: "utf8", env: gitEnv });
  assert.equal(pasted.status, 0, pasted.stderr);
  assert.equal(readFileSync(join(tree, "more.txt"), "utf8"), "half\n");
});

test("restart --carry of a lane with no commits, only uncommitted files, applies the diff: exit 0, staged", () => {
  // R1d-23 r6 N11: the builder committed nothing; an empty pick range is no conflict.
  const r = repo();
  const out = lane(r, "start", "T3").json;
  writeFileSync(join(out.worktree, "three.txt"), "a\nhalf done\nc\n");
  writeFileSync(join(out.worktree, "more.txt"), "half\n");
  writeFileSync(out.reportPath, "NEEDS_CONTEXT\nq\n");
  assert.equal(lane(r, "hold", "T3", "--for", "later", "--note", "x").exit, 0);
  const main = mainOf(r.root);
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.conflict, undefined);
  const ledger = ledgerOf(r.root, "T3");
  assert.deepEqual([ledger.carried.commits, ledger.carried.files], [0, 2]);
  assert.equal(ledger.carried.applied, true);
  assert.equal(git(ledger.worktree, "status", "--porcelain"), "A  more.txt\nM  three.txt");
  assert.deepEqual(mainOf(r.root), main);
  assert.equal(hasRef(r.root, "agentry/T3.1"), false, "all of it carried: the kept branch goes");
});

test("a restart stopped before the rename names the rename first and keeps the pick; the steps bring the work back", () => {
  // R1d-23 r6 N12: a ref under agentry/T3.1/ blocks the rename, so the old work is still on agentry/T3.
  const r = repo();
  worked(r);
  const oldTip = tipOf(r.root, "agentry/T3");
  git(r.root, "branch", "agentry/T3.1/x", "main");
  const res = spawnLane(r, ["exec", "restart", "T3", "--carry"]);
  const out = res.stdout + res.stderr;
  assert.equal(res.status, 1, out);
  assert.ok(out.includes("its old work is on agentry/T3 "), out);
  const pick = oldTip.slice(0, 7); // the old branch's one commit not on main
  const diff = join(archiveRuns(r.root, "T3", 1), "restart", "uncommitted.diff");
  const steps = out.split("→ fix that, then: ")[1]?.trim().split("; ") ?? [];
  assert.deepEqual(
    steps.map((s) => s.replace(/^.*exec start T3 --root .*$/, "START")),
    [
      `git update-ref refs/heads/agentry/T3.1 ${oldTip} ''`,
      `git update-ref -d refs/heads/agentry/T3 ${oldTip}`,
      "START",
      `in its worktree git cherry-pick ${pick}`,
      `git apply --3way ${diff}`,
    ],
    out,
  );
  git(r.root, "branch", "-D", "agentry/T3.1/x"); // "fix that"
  git(r.root, "update-ref", "refs/heads/agentry/T3.1", oldTip, "");
  git(r.root, "update-ref", "-d", "refs/heads/agentry/T3", oldTip);
  assert.equal(tipOf(r.root, "agentry/T3.1"), oldTip);
  const started = lane(r, "start", "T3");
  assert.equal(started.exit, 0, started.stderr);
  git(started.json.worktree, "cherry-pick", pick);
  git(started.json.worktree, "apply", "--3way", diff);
  assert.equal(readFileSync(join(started.json.worktree, "three.txt"), "utf8"), "a\nlane\nc\n");
  assert.equal(readFileSync(join(started.json.worktree, "more.txt"), "utf8"), "half\n");
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
  assert.equal(existsSync(archiveFile(r.root, "T3", 1)), false);
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
  const first = readFileSync(archiveFile(r.root, "T1", 1), "utf8");
  assert.deepEqual(JSON.parse(first).holds, held.holds);
  assert.equal(JSON.parse(first).holds.length, 1);
  assert.equal(JSON.parse(first).hold.for, "later");

  assert.equal(lane(r, "hold", "T1", "--for", "later").exit, 0);
  const again = lane(r, "restart", "T1");
  assert.equal(again.exit, 0, again.stderr);
  assert.equal(ledgerOf(r.root, "T1").restarted.from, "T1.2");
  assert.equal(readFileSync(archiveFile(r.root, "T1", 1), "utf8"), first);
  assert.ok(existsSync(archiveFile(r.root, "T1", 2)));
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
  assert.equal(existsSync(archiveFile(r.root, "T3", 1)), false);
  assert.equal(existsSync(join(processDir(r.root), "runs", "T3", "restart")), false);
  assert.equal(hasRef(r.root, "refs/heads/agentry/T3.1"), false);
});

test("in a root holding a space, a stopped restart's steps back quote the diff path", () => {
  const r = repo({ prefix: "restart repo-" });
  worked(r);
  git(r.root, "branch", "agentry/T3.1/x", "main"); // blocks the rename: the restart stops
  const res = spawnLane(r, ["exec", "restart", "T3", "--carry"]);
  const out = res.stdout + res.stderr;
  assert.equal(res.status, 1, out);
  const diff = join(archiveRuns(r.root, "T3", 1), "restart", "uncommitted.diff");
  const steps = out.split("→ fix that, then: ")[1]?.trim().split("; ") ?? [];
  assert.equal(steps.at(-1), `git apply --3way '${diff}'`, out);
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
    const newTip = tipOf(r.root, "agentry/T3");
    const out = res.stdout + res.stderr;
    assert.equal(res.status, 1, out);
    const runs = archiveRuns(r.root, "T3", 1);
    const diff = join(runs, "restart", "uncommitted.diff");
    assert.ok(out.includes(archiveFile(r.root, "T3", 1)), out);
    assert.ok(
      out.includes(`its old work is on agentry/T3.1 and its uncommitted diff at ${diff}`),
      out,
    );
    assert.equal(tipOf(r.root, "agentry/T3.1"), oldTip, "the kept branch survives");
    assert.match(readFileSync(diff, "utf8"), /\+\+\+ b\/more\.txt/);
    // The steps back, followed as printed, bring the commit and the uncommitted file back (r4 N9).
    const pick = oldTip.slice(0, 7); // the old branch's one commit not on main
    const steps = out.split("→ fix that, then: ")[1]?.trim().split("; ") ?? [];
    assert.deepEqual(
      steps.map((s) => s.replace(/^.*exec start T3 --root .*$/, "START")),
      [
        `git update-ref -d refs/heads/agentry/T3 ${newTip}`,
        "START",
        `in its worktree git cherry-pick ${pick}`,
        `git apply --3way ${diff}`,
      ],
      out,
    );
    git(r.root, "update-ref", "-d", "refs/heads/agentry/T3", newTip);
    const started = lane(r, "start", "T3");
    assert.equal(started.exit, 0, started.stderr);
    git(started.json.worktree, "cherry-pick", pick);
    git(started.json.worktree, "apply", "--3way", diff);
    assert.equal(readFileSync(join(started.json.worktree, "three.txt"), "utf8"), "a\nlane\nc\n");
    assert.equal(readFileSync(join(started.json.worktree, "more.txt"), "utf8"), "half\n");

    // A restart without --carry that stops names only the start (and the delete of a left branch).
    const clean = repo();
    worked(clean);
    const cleanBoard = join(clean.root, "plan", "BOARD.md");
    chmodSync(cleanBoard, 0o444);
    const plain = spawnLane(clean, ["exec", "restart", "T3"]);
    chmodSync(cleanBoard, 0o644);
    const said = plain.stdout + plain.stderr;
    assert.equal(plain.status, 1, said);
    assert.match(said, /→ fix that, then: .*exec start T3 --root \S+\s*$/, said);
    assert.doesNotMatch(said, /cherry-pick|git apply/);
  },
);

// ---- the old lane's verdict on the board (R1d-23 r2 N2) ------------------------------------------------

test("restarting a verified lane clears its board verdict: the new lane has none yet", () => {
  const r = repo();
  let out = lane(r, "start", "T3").json;
  commitFile(out.worktree, "three.txt", "a\nlane\nc\n", "feat: three");
  writeFileSync(out.reportPath, "DONE\nchanged three.txt\nused_memories: none\n");
  out = lane(r, "report", "T3").json;
  writeFileSync(out.reportPath, "Checked.\nused_memories: none\nVerdict: PASS\n");
  assert.equal(lane(r, "verdict", "T3").json.next, "gate");
  const row = () =>
    readFileSync(join(r.root, "plan", "BOARD.md"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("| T3 "));
  assert.match(row(), /\| PASS +\|$/);
  const t2 = lane(r, "start", "T2").json;
  writeFileSync(join(t2.worktree, "four.txt"), "half\n");
  const res = lane(r, "restart", "T3");
  assert.equal(res.exit, 0, res.stderr);
  assert.match(row(), /^\| T3 +\| doing +\| +\|$/);
  assert.equal(res.json.warning, undefined);
  // The clear is recorded: another running lane's guard lets it through.
  const parked = lane(r, "hold", "T2", "--for", "later");
  assert.equal(parked.exit, 0, parked.stderr);
  assert.equal(parked.json["main moved while parked"], undefined);
});

// ---- a lane others are stacked on (R1d-23 r2 N3) --------------------------------------------------------

test("a restart of a lane with an open stacked child is refused, nothing changed", () => {
  const r = repo();
  let out = lane(r, "start", "T3").json;
  commitFile(out.worktree, "three.txt", "a\nlane\nc\n", "feat: three");
  writeFileSync(out.reportPath, "DONE\nchanged three.txt\nused_memories: none\n");
  out = lane(r, "report", "T3").json;
  writeFileSync(out.reportPath, "Checked.\nused_memories: none\nVerdict: PASS\n");
  assert.equal(lane(r, "verdict", "T3").json.next, "gate");
  const child = lane(r, "start", "T2", "--on", "T3");
  assert.equal(child.exit, 0, child.stderr);
  const before = readFileSync(ledgerFile(r.root, "T3"), "utf8");
  const res = lane(r, "restart", "T3");
  assert.equal(res.exit, 2);
  assert.match(
    res.stderr,
    /✗ lane exec restart T3: T2 is stacked on T3: restack or close it first/,
  );
  assert.equal(readFileSync(ledgerFile(r.root, "T3"), "utf8"), before);
  assert.equal(existsSync(archiveFile(r.root, "T3", 1)), false);
});

// ---- empty ignored directories (field 94) ----------------------------------------------------------

test("an ignored directory holding only an empty one is no reason to refuse: the restart takes it down", () => {
  const r = repo();
  const out = worked(r);
  mkdirSync(join(out.worktree, "exports", "playtest"), { recursive: true });
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(
    existsSync(join(out.worktree, "exports")),
    false,
    "the removal takes the empty dirs",
  );
});

test("an ignored directory holding a file still refuses the restart, naming it", () => {
  const r = repo();
  const out = worked(r);
  mkdirSync(join(out.worktree, "exports", "playtest"), { recursive: true });
  writeFileSync(join(out.worktree, "exports", "playtest", "run.log"), "x\n");
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /holds 1 ignored file\(s\) a restart would delete \(exports\/\)/);
  assert.ok(existsSync(join(out.worktree, "exports", "playtest", "run.log")));
});

// ---- one ignored-file filter for restart, land cleanup and sweep (field 106, S45) -------------------

test("art/preview/** in cleanup.disposable lets a restart through and the cache goes with the worktree", () => {
  const r = repo();
  writeFileSync(join(r.root, ".gitignore"), ".agentry/run/\nart/preview/\n");
  git(r.root, "commit", "-qam", "chore: ignore the preview cache");
  const out = worked(r);
  mkdirSync(join(out.worktree, "art", "preview", "deep"), { recursive: true });
  writeFileSync(join(out.worktree, "art", "preview", "deep", "shot.png"), "x\n");
  const refused = lane(r, "restart", "T3", "--carry");
  assert.equal(refused.exit, 2);
  assert.match(refused.stderr, /ignored file\(s\) a restart would delete \(art\//);
  writeSpec(join(r.root, ".agentry"), { ...SPEC, cleanup: { disposable: ["art/preview/**"] } });
  git(r.root, "commit", "-qam", "chore: the preview cache is disposable");
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(existsSync(join(out.worktree, "art", "preview")), false);
});

test("a folder holding the cache and one other file still refuses the restart and loses nothing", () => {
  const r = repo();
  writeFileSync(join(r.root, ".gitignore"), ".agentry/run/\nart/\n");
  git(r.root, "commit", "-qam", "chore: ignore art");
  writeSpec(join(r.root, ".agentry"), { ...SPEC, cleanup: { disposable: ["art/preview/**"] } });
  git(r.root, "commit", "-qam", "chore: the preview cache is disposable");
  const out = worked(r);
  mkdirSync(join(out.worktree, "art", "preview", "deep"), { recursive: true });
  writeFileSync(join(out.worktree, "art", "preview", "deep", "shot.png"), "x\n");
  writeFileSync(join(out.worktree, "art", "source.psd"), "precious\n");
  const before = mainOf(r.root);
  const refused = lane(r, "restart", "T3", "--carry");
  assert.equal(refused.exit, 2);
  assert.match(refused.stderr, /art\//);
  assert.ok(existsSync(join(out.worktree, "art", "source.psd")));
  assert.ok(existsSync(join(out.worktree, "art", "preview", "deep", "shot.png")));
  assert.deepEqual(mainOf(r.root), before);
  rmSync(join(out.worktree, "art", "source.psd"));
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(existsSync(join(out.worktree, "art", "preview")), false);
});

// ---- a verified lane's restart (field 94) ---------------------------------------------------------

const row = (root, id) =>
  readFileSync(join(root, "plan", "BOARD.md"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`| ${id} `));

// T3 built (three.txt committed) and judged `verdict`; with PASS its gate is run and it is closed.
function judged(r, verdict = "PASS") {
  let out = lane(r, "start", "T3").json;
  commitFile(out.worktree, "three.txt", "a\nlane\nc\n", "feat: three");
  writeFileSync(out.reportPath, "DONE\nchanged three.txt\nused_memories: none\n");
  out = lane(r, "report", "T3").json;
  writeFileSync(out.reportPath, `Checked.\nused_memories: none\nVerdict: ${verdict}\n`);
  out = lane(r, "verdict", "T3").json;
  if (verdict !== "PASS") return out;
  assert.equal(lane(r, "gate", "T3").exit, 0);
  assert.equal(lane(r, "close", "T3").exit, 0);
  assert.equal(ledgerOf(r.root, "T3").state, "verified");
  return out;
}

test("restart --carry of a verified lane whose carry changed goes to the resolve check, never a build", () => {
  const r = repo();
  judged(r);
  const oldTip = tipOf(r.root, "agentry/T3");
  const oldBase = ledgerOf(r.root, "T3").base;
  // main edits three.txt elsewhere: the carry applies cleanly, its patch's context changed.
  commitFile(r.root, "three.txt", "top\na\nb\nc\n", "fix: main edits three.txt elsewhere");
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual(
    [res.json.step, res.json.next, res.json.state],
    ["restart", "resolve", "verifying"],
  );
  const ledger = ledgerOf(r.root, "T3");
  // The old lane's verdict comes first, carried from the archive; the resolve check after it.
  assert.deepEqual(
    ledger.rounds.map((x) => [x.n, x.step, x.role, x.mode, x.verdict, x.carried]),
    [
      [1, "verify", "verify", "fresh", "PASS", "T3.1"],
      [2, "resolve", "verify", "fresh", undefined, undefined],
    ],
  );
  assert.ok(
    existsSync(ledger.rounds[0].reportPath),
    "the carried verdict's report, in the archive",
  );
  assert.match(ledger.rounds[0].reportPath, /\/runs\/\.archive\/T3\.1\//);
  // The rebase recheck: the range-diff of the old base..tip against the new one, which the brief names.
  const [entry] = ledger.rebases;
  const newTip = tipOf(r.root, "agentry/T3");
  assert.deepEqual(
    [entry.fromBase, entry.fromTip, entry.toBase, entry.toTip, entry.changed],
    [oldBase, oldTip, tipOf(r.root, "main"), newTip, true],
  );
  assert.match(readFileSync(entry.rangeDiff, "utf8"), /^1: +[0-9a-f]+ ! 1: +[0-9a-f]+ feat: three/);
  assert.equal(res.json.rangeDiff, entry.rangeDiff);
  // The brief says the branch was carried by a restart, and points at the range-diff, not the old report.
  const brief = readFileSync(res.json.brief, "utf8");
  assert.match(brief, /^# Resolve check T3, round 2/); // round 1 is the carried verdict
  assert.match(
    brief,
    /rebased\s+onto `main`, or carried onto a fresh branch from it by a restart\./,
  );
  assert.ok(brief.includes(entry.rangeDiff), brief);
  assert.doesNotMatch(brief, /## Carried work/);
  // The board: built, its verdict standing for the carried work.
  assert.match(row(r.root, "T3"), /^\| T3 +\| verify +\| PASS +\|$/);
  // The check passes: the gate, then the close, as after a rebase.
  writeFileSync(
    res.json.reportPath,
    "The carry keeps both sides.\nused_memories: none\nVerdict: PASS\n",
  );
  assert.equal(lane(r, "verdict", "T3").json.next, "gate");
  assert.equal(lane(r, "gate", "T3").exit, 0);
  assert.equal(ledgerOf(r.root, "T3").state, "verified");
});

test("restart --carry of a verified lane whose carry is the same patch goes to the gate, no round", () => {
  const r = repo();
  judged(r);
  commitFile(r.root, "other.txt", "x\n", "chore: main moves");
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual([res.json.next, res.json.state], ["gate", "verifying"]);
  const ledger = ledgerOf(r.root, "T3");
  assert.deepEqual(
    ledger.rounds.map((x) => [x.step, x.verdict, x.carried]),
    [["verify", "PASS", "T3.1"]],
  );
  assert.equal(ledger.rebases[0].changed, false);
  assert.equal(ledger.gateTip, tipOf(r.root, "agentry/T3"));
  assert.match(row(r.root, "T3"), /^\| T3 +\| verify +\| PASS +\|$/);
  assert.equal(lane(r, "gate", "T3").exit, 0);
  assert.deepEqual(
    [ledgerOf(r.root, "T3").state, ledgerOf(r.root, "T3").next],
    ["verified", "close"],
  );
});

test('under exec.rebase "gate" a verified lane\'s changed carry goes to the gate too', () => {
  const r = repo({ spec: { ...SPEC, exec: { rebase: "gate" } } });
  judged(r);
  commitFile(r.root, "three.txt", "top\na\nb\nc\n", "fix: main edits three.txt elsewhere");
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual([res.json.next, res.json.state], ["gate", "verifying"]);
  const ledger = ledgerOf(r.root, "T3");
  assert.deepEqual([ledger.route.rebase, ledger.rebases[0].changed], ["gate", true]);
  assert.deepEqual(
    ledger.rounds.map((x) => [x.step, x.verdict, x.carried]),
    [["verify", "PASS", "T3.1"]],
  );
});

test("a verified lane's restart that stops past the archive clears the old verdict from the board", () => {
  const r = repo();
  judged(r);
  git(r.root, "branch", "agentry/T3.1/x", "main"); // blocks keeping the old branch: a stop past the archive
  const res = spawnLane(r, ["exec", "restart", "T3", "--carry"]);
  const out = res.stdout + res.stderr;
  assert.equal(res.status, 1, out);
  assert.ok(out.includes("but the restart stopped: "), out);
  assert.match(
    row(r.root, "T3"),
    /\| +\|$/,
    "the old lane's PASS does not stand beside a stopped restart",
  );
  assert.doesNotMatch(out, /board set/);
});

test("restart --carry of a verified lane whose carry conflicts keeps today's build round", () => {
  const r = repo();
  judged(r);
  commitFile(r.root, "three.txt", "a\nmain\nc\n", "fix: three on main");
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 1, res.stderr);
  assert.deepEqual([res.json.next, res.json.state], ["build", "building"]);
  assert.equal(ledgerOf(r.root, "T3").rebases, undefined);
  assert.match(row(r.root, "T3"), /^\| T3 +\| doing +\| +\|$/);
});

test("restart --carry of a lane whose last verdict is FAIL still builds", () => {
  const r = repo();
  assert.equal(judged(r, "FAIL").next, "fix");
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual([res.json.next, res.json.state], ["build", "building"]);
  assert.equal(ledgerOf(r.root, "T3").rebases, undefined);
  // A lane not verified carries no verdict: its FAIL stays in the archive.
  assert.deepEqual(
    ledgerOf(r.root, "T3").rounds.map((x) => [x.step, x.verdict, x.carried]),
    [["build", undefined, undefined]],
  );
});

test("restart --carry of a lane with no verdict still builds", () => {
  const r = repo();
  worked(r);
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual([res.json.next, res.json.state], ["build", "building"]);
  assert.equal(ledgerOf(r.root, "T3").rounds[0].step, "build");
});

// ---- a flagged item's verified carry lands on the verdicts it carries (field 94) --------------------

const FLAG_SPEC = {
  ...SPEC,
  kinds: {
    task: {
      ...SPEC.kinds.task,
      fields: { ...SPEC.kinds.task.fields, flag: { column: "Flag", type: "flag", mark: "x" } },
    },
  },
};
const FLAG_BOARD = `# Restart

## Tasks

| Task | Status | Verdict | Flag |
| ---- | ------ | ------- | ---- |
| T1   | todo   |         |      |
| T2   | todo   |         |      |
| T3   | todo   |         | x    |
`;
const merge = (r, ...args) =>
  spawnSync("node", [LANE, "merge", ...args, "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home, NO_COLOR: "1" },
  });

for (const verify of ["flagged", "all"])
  test(`exec.verify ${verify}: a flagged item's unchanged verified carry gates, closes and preflights clean`, () => {
    const r = repo({ spec: { ...FLAG_SPEC, exec: { verify } }, board: FLAG_BOARD });
    judged(r);
    commitFile(r.root, "other.txt", "x\n", "chore: main moves");
    const res = lane(r, "restart", "T3", "--carry");
    assert.equal(res.exit, 0, res.stderr);
    assert.equal(res.json.next, "gate");
    assert.equal(lane(r, "gate", "T3").exit, 0);
    const closed = lane(r, "close", "T3");
    assert.equal(closed.exit, 0, closed.stderr);
    assert.doesNotMatch(closed.json.episode.outcome, /no verifier read it/);
    assert.match(closed.json.episode.outcome, /^verified \(PASS\)/);
    const pre = merge(r, "T3", "--preflight");
    assert.equal(pre.status, 0, pre.stdout + pre.stderr);
    assert.doesNotMatch(pre.stdout + pre.stderr, /reverify/);
  });

// ---- carried verdicts: the lane's own budget, the first marker, a fresh recheck (field 94) ----------

const NO_FINAL = { ...SPEC, exec: { final: "never" } };
// The verifier `agent` sent on `out` returns `verdict`.
const sayVerdict = (r, out, verdict, agent) => {
  writeFileSync(out.reportPath, `Checked.\nused_memories: none\nVerdict: ${verdict}\n`);
  return lane(r, "verdict", "T3", "--agent", agent).json;
};

// T3 built, judged FAIL (by verifier-1), fixed, rechecked PASS, gated and closed: two verdicts of its own.
function failedThenPassed(r) {
  let out = lane(r, "start", "T3").json;
  const wt = out.worktree;
  commitFile(wt, "three.txt", "a\nlane\nc\n", "feat: three");
  writeFileSync(out.reportPath, "DONE\nchanged three.txt\nused_memories: none\n");
  out = lane(r, "report", "T3").json;
  assert.equal(sayVerdict(r, out, "FAIL", "verifier-1").next, "fix");
  const fix = ledgerOf(r.root, "T3").rounds.at(-1);
  commitFile(wt, "three.txt", "a\nlane fixed\nc\n", "fix: three");
  writeFileSync(fix.reportPath, "DONE\nfixed\nused_memories: none\n");
  out = lane(r, "report", "T3").json;
  assert.equal(sayVerdict(r, out, "PASS", "verifier-1").next, "gate");
  assert.equal(lane(r, "gate", "T3").exit, 0);
  assert.equal(lane(r, "close", "T3").exit, 0);
}
// The verified lane carried by a restart onto a moved main, gated and closed again.
function carriedOver(r) {
  commitFile(r.root, "other.txt", `${Date.now()}\n`, "chore: main moves");
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "gate");
  assert.equal(lane(r, "gate", "T3").exit, 0);
  assert.equal(lane(r, "close", "T3").exit, 0);
}
// The owner sends the closed lane back; its builder commits and reports: the view of the recheck sent.
function ownerFixed(r, line) {
  const res = lane(r, "fix", "T3", "--owner", line);
  assert.equal(res.exit, 0, res.stderr);
  commitFile(ledgerOf(r.root, "T3").worktree, "more.txt", `${line}\n`, `feat: ${line}`);
  writeFileSync(res.json.reportPath, `DONE\n${line}\nused_memories: none\n`);
  return lane(r, "report", "T3").json;
}
// After a FAIL: the builder commits a fix and reports.
function fixed(r, line) {
  const fix = ledgerOf(r.root, "T3").rounds.at(-1);
  commitFile(ledgerOf(r.root, "T3").worktree, "more.txt", `${line}\n`, `fix: ${line}`);
  writeFileSync(fix.reportPath, `DONE\n${line}\nused_memories: none\n`);
  return lane(r, "report", "T3").json;
}
const marks = (root) =>
  ledgerOf(root, "T3").rounds.map((x) => [x.n, x.step, x.verdict ?? null, x.carried ?? null]);

test("two carried verdicts, then the restarted lane's first FAIL goes to fix, not the three-verdict stop", () => {
  const r = repo({ spec: NO_FINAL });
  failedThenPassed(r);
  carriedOver(r);
  const out = ownerFixed(r, "one more line");
  const v = sayVerdict(r, out, "FAIL", "verifier-2");
  assert.deepEqual([v.next, v.state], ["fix", "fixing"]);
  assert.deepEqual(marks(r.root), [
    [1, "verify", "FAIL", "T3.1"],
    [2, "recheck", "PASS", "T3.1"],
    [3, "fix", null, null],
    [4, "recheck", "FAIL", null],
    [5, "fix", null, null],
  ]);
});

test("one carried PASS: two FAILs of the lane's own fix, its third stops at verdict 3", () => {
  const r = repo({ spec: NO_FINAL });
  judged(r);
  carriedOver(r);
  let out = ownerFixed(r, "one more line");
  assert.equal(sayVerdict(r, out, "FAIL", "verifier-2").next, "fix");
  out = fixed(r, "fixed once");
  assert.equal(sayVerdict(r, out, "FAIL", "verifier-2").next, "fix");
  out = fixed(r, "fixed twice");
  const v = sayVerdict(r, out, "FAIL", "verifier-2");
  assert.deepEqual([v.next, v.state], ["stop", "stopped"]);
  assert.equal(
    ledgerOf(r.root, "T3").stopReason,
    "FAIL at verdict 3; every verdict goes to the owner",
  );
});

test("a round carried by two restarts keeps its first marker and its first archive's files", () => {
  const r = repo({ spec: NO_FINAL });
  judged(r);
  carriedOver(r);
  carriedOver(r);
  const [round] = ledgerOf(r.root, "T3").rounds;
  assert.deepEqual([round.step, round.verdict, round.carried], ["verify", "PASS", "T3.1"]);
  assert.match(round.reportPath, /\/runs\/\.archive\/T3\.1\//);
  assert.ok(existsSync(round.reportPath));
});

test("a recheck whose verifier comes from a carried round runs fresh; one of the lane's own resumes", () => {
  const r = repo({ spec: NO_FINAL });
  failedThenPassed(r);
  carriedOver(r);
  const carried = ledgerOf(r.root, "T3").rounds[1];
  assert.equal(carried.agent, "verifier-1");
  let out = ownerFixed(r, "one more line");
  assert.deepEqual([out.next, out.mode, out.agent], ["recheck", "fresh", undefined]);
  // The fresh verifier still reads the carried report it rechecks.
  assert.ok(readFileSync(out.brief, "utf8").includes(carried.reportPath));
  assert.equal(sayVerdict(r, out, "FAIL", "verifier-2").next, "fix");
  out = fixed(r, "fixed once");
  assert.deepEqual([out.next, out.mode, out.agent], ["recheck", "resume", "verifier-2"]);
});

// ---- the lane branch by its exact listed name, never by a spelling the list did not give (S50) ----

const branchRefs = (root) =>
  git(root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
// A loose case twin `name` at main's tip beside the packed refs: what a case twin looks like on APFS.
function packedTwin(root, name) {
  git(root, "pack-refs", "--all");
  git(root, "update-ref", `refs/heads/${name}`, tipOf(root, "main"));
}
const REAL_GIT = process.env.PATH.split(":")
  .map((dir) => join(dir, "git"))
  .find((file) => existsSync(file));
/** `lane exec <args>` with a `git` on PATH that, right after the first git call whose argv matches `on`,
 *  makes the loose case twin `twin` at `at` (default main's tip) beside the packed refs: a twin made
 *  mid-call. */
function laneWithTwinAfter(r, { on, twin, at = tipOf(r.root, "main") }, ...args) {
  const dir = temp("restart-shim-");
  const mark = join(dir, "mark");
  writeFileSync(mark, "");
  writeFileSync(
    join(dir, "git"),
    `#!/bin/bash
"${REAL_GIT}" "$@"; st=$?
if [ -f "${mark}" ] && [[ "$*" =~ $TWIN_ON ]]; then
  rm -f "${mark}"
  "${REAL_GIT}" -C "${r.root}" pack-refs --all
  "${REAL_GIT}" -C "${r.root}" update-ref "refs/heads/${twin}" ${at}
fi
exit $st
`,
  );
  chmodSync(join(dir, "git"), 0o755);
  const res = spawnSync("node", [LANE, "exec", ...args, "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home, PATH: `${dir}:${process.env.PATH}`, TWIN_ON: on },
  });
  assert.equal(existsSync(mark), false, `no git call matched ${on}`);
  return { exit: res.status, out: res.stdout + res.stderr };
}

test("restart and restart --carry refuse a lane branch with a case twin: nothing written, neither ref moved", () => {
  const r = repo();
  const old = worked(r);
  packedTwin(r.root, "agentry/t3");
  const [refs, ledger, status] = [
    branchRefs(r.root),
    readFileSync(ledgerFile(r.root, "T3"), "utf8"),
    git(old.worktree, "status", "--porcelain"),
  ];
  for (const args of [
    ["restart", "T3"],
    ["restart", "T3", "--carry"],
  ]) {
    const res = lane(r, ...args);
    assert.equal(res.exit, 2, res.stderr);
    assert.match(res.stderr, /agentry\/T3 has a case twin agentry\/t3: rename one first/);
    assert.equal(branchRefs(r.root), refs);
    assert.equal(readFileSync(ledgerFile(r.root, "T3"), "utf8"), ledger);
    assert.equal(git(old.worktree, "status", "--porcelain"), status);
    assert.equal(existsSync(archiveFile(r.root, "T3", 1)), false);
  }
});

test("a case twin made once the worktree is gone stops the restart before the rename: the twin is untouched", () => {
  const r = repo();
  worked(r);
  const oldTip = tipOf(r.root, "agentry/T3");
  const res = laneWithTwinAfter(
    r,
    { on: "worktree remove", twin: "agentry/t3" },
    "restart",
    "T3",
    "--carry",
  );
  assert.equal(res.exit, 1, res.out);
  assert.match(res.out, /agentry\/T3 has a case twin agentry\/t3: rename one first/);
  assert.doesNotMatch(res.out, /branch -[Dm]/);
  const refs = branchRefs(r.root);
  assert.ok(refs.includes(`refs/heads/agentry/T3 ${oldTip}`), refs);
  assert.ok(refs.includes(`refs/heads/agentry/t3 ${tipOf(r.root, "main")}`), refs);
  assert.ok(!refs.includes("agentry/T3.1"), refs);
});

test("a case twin of the kept branch made during the carry is never deleted with it", () => {
  const r = repo();
  worked(r);
  const oldTip = tipOf(r.root, "agentry/T3");
  const res = laneWithTwinAfter(
    r,
    { on: "cherry-pick", twin: "agentry/t3.1" },
    "restart",
    "T3",
    "--carry",
  );
  assert.equal(res.exit, 0, res.out);
  const refs = branchRefs(r.root);
  assert.ok(refs.includes(`refs/heads/agentry/T3.1 ${oldTip}`), refs);
  assert.ok(refs.includes(`refs/heads/agentry/t3.1 ${tipOf(r.root, "main")}`), refs);
});

test("a packed lane branch is kept at its listed tip as agentry/T3.1, and a clean --carry drops it", () => {
  const plain = repo();
  worked(plain);
  const oldTip = tipOf(plain.root, "agentry/T3");
  git(plain.root, "pack-refs", "--all");
  assert.equal(lane(plain, "restart", "T3").exit, 0);
  assert.equal(tipOf(plain.root, "agentry/T3.1"), oldTip);
  assert.equal(tipOf(plain.root, "agentry/T3"), tipOf(plain.root, "main"));
  const carried = repo();
  worked(carried);
  git(carried.root, "pack-refs", "--all");
  const res = lane(carried, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(hasRef(carried.root, "refs/heads/agentry/T3.1"), false);
  assert.equal(git(carried.root, "log", "-1", "--format=%s", "agentry/T3"), "feat: three");
});

test("a twin at the lane's own sha made between the rename's two steps stops it: neither name is deleted", () => {
  for (const args of [
    ["restart", "T3"],
    ["restart", "T3", "--carry"],
  ]) {
    const r = repo();
    worked(r);
    const oldTip = tipOf(r.root, "agentry/T3");
    const on = " update-ref refs/heads/agentry/T3\\.1 ";
    const res = laneWithTwinAfter(r, { on, twin: "agentry/t3", at: oldTip }, ...args);
    assert.equal(res.exit, 1, res.out);
    assert.match(res.out, /agentry\/T3 has a case twin agentry\/t3: rename one first/);
    const refs = branchRefs(r.root);
    for (const b of ["agentry/T3", "agentry/t3", "agentry/T3.1"])
      assert.ok(refs.includes(`refs/heads/${b} ${oldTip}`), `${b}: ${refs}`);
    assert.doesNotMatch(res.out, /branch -[Dm]/);
  }
});

test("a kept name another branch has in another case refuses the restart before anything is written", () => {
  const r = repo();
  const old = worked(r);
  git(r.root, "branch", "agentry/t3.1", "main");
  const [refs, ledger, status] = [
    branchRefs(r.root),
    readFileSync(ledgerFile(r.root, "T3"), "utf8"),
    git(old.worktree, "status", "--porcelain"),
  ];
  for (const args of [
    ["restart", "T3"],
    ["restart", "T3", "--carry"],
  ]) {
    const res = lane(r, ...args);
    assert.equal(res.exit, 2, res.stderr);
    assert.match(
      res.stderr,
      /agentry\/t3\.1 would be a case twin of agentry\/T3\.1: rename it first/,
    );
    assert.equal(branchRefs(r.root), refs);
    assert.equal(readFileSync(ledgerFile(r.root, "T3"), "utf8"), ledger);
    assert.equal(git(old.worktree, "status", "--porcelain"), status);
    assert.equal(existsSync(archiveFile(r.root, "T3", 1)), false);
    assert.equal(existsSync(join(processDir(r.root), "runs", "T3", "restart")), false);
  }
});

test("a lane branch listed only in another case refuses the restart: no twin pair is cut beside it", () => {
  const r = repo();
  const old = worked(r);
  const oldTip = tipOf(r.root, "agentry/T3");
  git(r.root, "worktree", "remove", "--force", old.worktree);
  // Only `agentry/t3` is listed; the ledger still says `agentry/T3`.
  git(r.root, "pack-refs", "--all");
  git(r.root, "update-ref", "-d", "refs/heads/agentry/T3", oldTip);
  git(r.root, "update-ref", "refs/heads/agentry/t3", oldTip);
  const [refs, ledger] = [branchRefs(r.root), readFileSync(ledgerFile(r.root, "T3"), "utf8")];
  for (const args of [
    ["restart", "T3"],
    ["restart", "T3", "--carry"],
  ]) {
    const res = lane(r, ...args);
    assert.equal(res.exit, 2, res.stderr);
    assert.match(
      res.stderr,
      /agentry\/T3 is listed only as agentry\/t3: rename it to its exact name first/,
    );
    assert.equal(branchRefs(r.root), refs);
    assert.equal(readFileSync(ledgerFile(r.root, "T3"), "utf8"), ledger);
    assert.equal(existsSync(archiveFile(r.root, "T3", 1)), false);
  }
});

// The field shape (field 100): T3 cut at A, main moves to B, the builder rebases the lane onto B in its
// worktree and adds commits; then held. `agentry/T3` is main + the lane's own commits.
function rebasedInBranch(r) {
  const out = lane(r, "start", "T3").json;
  commitFile(out.worktree, "three.txt", "a\nlane\nc\n", "feat: three");
  commitFile(r.root, "docs.txt", "one\n", "docs: main one");
  commitFile(r.root, "docs.txt", "one\ntwo\n", "docs: main two");
  git(out.worktree, "rebase", "-q", "main");
  commitFile(out.worktree, "more.txt", "more\n", "feat: more");
  assert.equal(lane(r, "hold", "T3", "--for", "later", "--note", "start over").exit, 0);
  return out;
}

test("restart --carry of a lane rebased in-branch onto a newer main carries only its own commits", () => {
  const r = repo();
  rebasedInBranch(r);
  const main = mainOf(r.root);
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.conflict, undefined);
  assert.match(res.json.carried, /^2 commits, 0 files uncommitted/);
  const ledger = ledgerOf(r.root, "T3");
  assert.equal(ledger.carried.commits, 2);
  assert.equal(ledger.carried.skipped, undefined);
  // Main's commits are never picked again: the new branch is main + the two lane commits.
  assert.deepEqual(git(r.root, "log", "--format=%s", "main..agentry/T3").split("\n"), [
    "feat: more",
    "feat: three",
  ]);
  assert.equal(tipOf(r.root, "agentry/T3~2"), main[0]);
  assert.match(
    readFileSync(res.json.brief, "utf8"),
    /in the tree \(2 commits, 0 files uncommitted\)/,
  );
  assert.deepEqual(mainOf(r.root), main, "main is untouched");
});

test("a lane commit whose patch main has already is skipped and listed, never picked again", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  const landed = commitFile(out.worktree, "three.txt", "a\nlane\nc\n", "feat: three");
  commitFile(out.worktree, "more.txt", "more\n", "feat: more");
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  commitFile(r.root, "docs.txt", "one\n", "docs: main moves");
  git(r.root, "cherry-pick", landed); // the same patch lands on main under another sha
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  const ledger = ledgerOf(r.root, "T3");
  assert.equal(ledger.carried.commits, 1);
  assert.deepEqual(ledger.carried.skipped, [{ sha: landed, subject: "feat: three" }]);
  assert.equal(res.json.skipped, `1 already on main: ${landed.slice(0, 7)} feat: three`);
  assert.deepEqual(git(r.root, "log", "--format=%s", "main..agentry/T3").split("\n"), [
    "feat: more",
  ]);
});

test("restart --carry of a lane branch not based on main's first-parent line refuses, nothing written", () => {
  // The lane was merged into main by hand (a merge commit), then built on: its merge base with main is
  // its own first commit, on main's second-parent side only.
  const r = repo();
  const out = lane(r, "start", "T3").json;
  commitFile(out.worktree, "three.txt", "a\nlane\nc\n", "feat: three");
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  git(r.root, "merge", "-q", "--no-ff", "-m", "merge agentry/T3 by hand", "agentry/T3");
  commitFile(out.worktree, "more.txt", "more\n", "feat: more");
  const [ledger, tip, status] = [
    readFileSync(ledgerFile(r.root, "T3"), "utf8"),
    tipOf(r.root, "agentry/T3"),
    git(out.worktree, "status", "--porcelain"),
  ];
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 2, res.stderr);
  assert.match(
    res.stderr,
    /agentry\/T3 is not based on main: rebase it onto main or land it with lane merge --branch/,
  );
  assert.equal(readFileSync(ledgerFile(r.root, "T3"), "utf8"), ledger);
  assert.equal(tipOf(r.root, "agentry/T3"), tip);
  assert.equal(git(out.worktree, "status", "--porcelain"), status);
  assert.equal(existsSync(archiveFile(r.root, "T3", 1)), false);
  assert.equal(existsSync(join(processDir(r.root), "runs", "T3", "restart")), false);
  assert.equal(hasRef(r.root, "refs/heads/agentry/T3.1"), false);
});

test("a build brief and a fix brief say never to rebase or merge main inside the lane", () => {
  const r = repo();
  const res = lane(r, "start", "T3");
  assert.equal(res.exit, 0, res.stderr);
  const rule =
    /Never `git rebase` or `git merge` main inside the lane: when main must be taken in, report it and ask for\s+`exec rebase` \(a verified lane\) or `exec restart --carry`\./;
  assert.match(readFileSync(res.json.brief, "utf8"), rule);
  // A fix round: the verifier's FAIL sends the builder back.
  commitFile(res.json.worktree, "three.txt", "a\nlane\nc\n", "feat: three");
  writeFileSync(res.json.reportPath, "DONE\nthree\nused_memories: none\n");
  const verify = lane(r, "report", "T3").json;
  writeFileSync(verify.reportPath, "Missing more.txt.\nused_memories: none\nVerdict: FAIL\n");
  const fix = lane(r, "verdict", "T3");
  assert.equal(fix.json.next, "fix", fix.stderr);
  const text = readFileSync(fix.json.brief, "utf8");
  assert.match(
    text,
    /never `git rebase` or `git merge` main into the branch; report it and ask for\n`exec rebase`/,
  );
  assert.match(text, rule);
});

// T4 through two owner gates: step 1 and 2 built, reported and OK'd; the builder of step 3 has committed c.txt
// and is parked (`hold --for later`), so the lane can restart.
function midStepThree(r) {
  const out = lane(r, "start", "T4").json;
  const wt = out.worktree;
  commitFile(wt, "a.txt", "a\n", "feat: a");
  writeFileSync(out.reportPath, "DONE\na\nused_memories: none\n");
  assert.equal(lane(r, "report", "T4").json.state, "held");
  const two = lane(r, "resume", "T4", "--note", "step 1 is fine").json;
  commitFile(wt, "b.txt", "b\n", "feat: b");
  writeFileSync(two.reportPath, "DONE\nb\nused_memories: none\n");
  assert.equal(lane(r, "report", "T4").json.state, "held");
  const three = lane(r, "resume", "T4", "--note", "step 2 is fine").json;
  commitFile(wt, "c.txt", "c\n", "feat: c");
  assert.equal(lane(r, "hold", "T4", "--for", "later", "--note", "park").exit, 0);
  return { wt, three };
}

test("restart --carry of a 3-step lane stopped in step 3 keeps the owner OKs and briefs step 3, not step 1", () => {
  const r = repo();
  midStepThree(r);
  const old = ledgerOf(r.root, "T4");
  const res = lane(r, "restart", "T4", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual([res.json.next, res.json.state], ["continue", "building"]);
  const ledger = ledgerOf(r.root, "T4");
  // The OKs of the two passed gates, as the old ledger had them.
  assert.deepEqual(
    ledger.holds.map((h) => [h.for, h.stepRun, h.note]),
    [
      ["owner", [1, 1], "step 1 is fine"],
      ["owner", [2, 2], "step 2 is fine"],
    ],
  );
  // Their evidence read where the archive holds the old run's files.
  assert.deepEqual(
    ledger.holds.map((h) => h.evidence),
    old.holds.map((h) => h.evidence.replace("/runs/T4/", "/runs/.archive/T4.1/")),
  );
  // The first round: a fresh builder continues step 3.
  const first = ledger.rounds[0];
  assert.deepEqual([first.step, first.mode, first.stepRun], ["continue", "fresh", [3, 3]]);
  assert.match(first.from, /T4\.1\/r\d+-\w+\.report\.md$/);
  assert.deepEqual(ledger.carried.stepRun, [3, 3]);
  assert.deepEqual(ledger.carried.rounds, {
    total: old.rounds.length,
    builds: old.rounds.length,
    verdicts: 0,
  });
  const brief = readFileSync(res.json.brief, "utf8");
  assert.match(brief, /Built before this round \(on the branch\): steps 1–2\./);
  assert.match(brief, /step 3 of 3/);
  assert.match(brief, /step 2 is fine/);
  assert.doesNotMatch(brief, /step 1 of 3/);
  assert.match(res.json.progress, /2 owner OK\(s\) carried; the first brief is for step 3 of 3/);
  assert.equal(res.json.dropped, undefined);
});

test("a restart before any step passed still starts at step 1, with no OKs", () => {
  const r = repo();
  const out = lane(r, "start", "T4").json;
  commitFile(out.worktree, "a.txt", "a\n", "feat: a");
  assert.equal(lane(r, "hold", "T4", "--for", "later", "--note", "park").exit, 0);
  const res = lane(r, "restart", "T4", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "build");
  const ledger = ledgerOf(r.root, "T4");
  assert.deepEqual([ledger.rounds[0].step, ledger.rounds[0].stepRun], ["build", [1, 1]]);
  assert.equal(ledger.holds, undefined);
  assert.equal(ledger.carried.stepRun, undefined);
});

test("an owner hold not yet answered is no OK: the step is built again and the output says so", () => {
  const r = repo();
  const out = lane(r, "start", "T4").json;
  commitFile(out.worktree, "a.txt", "a\n", "feat: a");
  writeFileSync(out.reportPath, "DONE\na\nused_memories: none\n");
  assert.equal(lane(r, "report", "T4").json.state, "held");
  const res = lane(r, "restart", "T4", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.match(res.json.dropped, /the owner hold on step 1 of 3: not an OK/);
  const ledger = ledgerOf(r.root, "T4");
  assert.deepEqual([ledger.rounds[0].step, ledger.rounds[0].stepRun], ["build", [1, 1]]);
});

test("a contract whose steps changed since drops the OKs and the pointer, and says so", () => {
  const r = repo();
  midStepThree(r);
  const tasks = readFileSync(join(r.root, "plan", "TASKS.md"), "utf8");
  commitFile(
    r.root,
    "plan/TASKS.md",
    tasks.replace("Write c.txt", "Write c.txt twice"),
    "docs: edit",
  );
  const res = lane(r, "restart", "T4", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.match(
    res.json.dropped,
    /2 owner OK\(s\) and the step pointer: the contract's steps changed/,
  );
  assert.equal(res.json.next, "build");
  assert.equal(ledgerOf(r.root, "T4").holds, undefined);
});

test("owns --add grants ride through a restart --carry, never more than the old ledger had", () => {
  const r = repo();
  midStepThree(r);
  assert.equal(lane(r, "owns", "T4", "--add", "extra.txt", "--apply").exit, 0);
  const old = ledgerOf(r.root, "T4").owned;
  assert.ok(old.some((o) => o.path === "extra.txt"));
  const res = lane(r, "restart", "T4", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  const now = ledgerOf(r.root, "T4").owned;
  assert.deepEqual(now.map((o) => o.path).sort(), old.map((o) => o.path).sort());
  // A second restart keeps them again, and the OKs with them.
  assert.equal(lane(r, "hold", "T4", "--for", "later", "--note", "park").exit, 0);
  const again = lane(r, "restart", "T4", "--carry");
  assert.equal(again.exit, 0, again.stderr);
  assert.deepEqual(
    ledgerOf(r.root, "T4")
      .owned.map((o) => o.path)
      .sort(),
    old.map((o) => o.path).sort(),
  );
  assert.equal(ledgerOf(r.root, "T4").holds.length, 2);
  assert.deepEqual(ledgerOf(r.root, "T4").rounds[0].stepRun, [3, 3]);
});

// The field shape (R1e-1 r3 N2): T3 started, main moves, the builder rebases onto it in the worktree.
const COMMITS_SPEC = { ...SPEC, commits: { subjectPattern: "^(feat|fix): " } };
function heldMain(r, { own }) {
  const out = lane(r, "start", "T3").json;
  if (own) commitFile(out.worktree, "three.txt", "a\nlane\nc\n", "feat: three");
  commitFile(r.root, "docs.txt", "one\n", "docs: main one");
  commitFile(r.root, "docs.txt", "one\ntwo\n", "docs: main two");
  git(out.worktree, "rebase", "-q", "main");
  writeFileSync(out.reportPath, "DONE\nthree\nused_memories: none\n");
  return out;
}

test("a branch holding main is not charged main's commit subjects: only the lane's own are checked", () => {
  const r = repo({ spec: COMMITS_SPEC });
  heldMain(r, { own: true });
  const res = lane(r, "report", "T3");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "verify", JSON.stringify(res.json));
});

test("a branch holding main with no commit of its own still trips no commits past base", () => {
  const r = repo();
  heldMain(r, { own: false });
  const res = lane(r, "report", "T3");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "fix");
  assert.match(ledgerOf(r.root, "T3").rounds[0].guards.join(";"), /no commits past base/);
});

test("the lane's own subjects are still checked once the branch holds main", () => {
  const r = repo({ spec: COMMITS_SPEC });
  const out = lane(r, "start", "T3").json;
  commitFile(out.worktree, "three.txt", "a\nlane\nc\n", "wip three");
  commitFile(r.root, "docs.txt", "one\n", "feat: main one");
  git(out.worktree, "rebase", "-q", "main");
  writeFileSync(out.reportPath, "DONE\nthree\nused_memories: none\n");
  const res = lane(r, "report", "T3");
  assert.equal(res.json.next, "fix");
  assert.match(ledgerOf(r.root, "T3").rounds[0].guards.join(";"), /wip three/);
});

test("a stepless lane held for the owner mid-round restarts: the hold is named by its round, not a run", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  commitFile(out.worktree, "three.txt", "a\nlane\nc\n", "feat: three");
  writeFileSync(out.reportPath, "DONE\nthree\nused_memories: none\n");
  assert.equal(lane(r, "hold", "T3", "--for", "owner", "--note", "look").exit, 0);
  assert.equal(ledgerOf(r.root, "T3").hold.stepRun, null);
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.match(res.json.dropped, /the owner hold on round 1: not an OK, not carried/);
  assert.equal(res.json.next, "build");
});

test("a lane held at the notes cap (an owner hold with no run) restarts: named as the cap, not a step", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  commitFile(out.worktree, "three.txt", "a\nlane\nc\n", "feat: three");
  assert.equal(lane(r, "hold", "T3", "--for", "later", "--note", "park").exit, 0);
  // Planted: the shape a notes-cap hold has (rounds.mjs), without the flagged flow that makes one.
  const file = ledgerFile(r.root, "T3");
  const planted = ledgerOf(r.root, "T3");
  planted.hold = {
    for: "owner",
    when: "verdict",
    stepRun: null,
    evidence: out.reportPath,
    since: "2026-01-01T00:00:00.000Z",
    round: 1,
    tip: tipOf(r.root, "agentry/T3"),
  };
  writeFileSync(file, JSON.stringify(planted));
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.match(res.json.dropped, /the owner hold at the notes cap: not an OK, not carried/);
  assert.doesNotMatch(res.json.dropped, /built again/);
});

test("owns --set is carried as the old ledger had it; a changed contract keeps its grants beside its own owns", () => {
  const r = repo();
  midStepThree(r);
  assert.equal(lane(r, "owns", "T4", "--set", "a.txt,b.txt", "--apply").exit, 0);
  assert.equal(lane(r, "owns", "T4", "--add", "extra.txt", "--apply").exit, 0);
  const old = ledgerOf(r.root, "T4").owned;
  assert.deepEqual(
    old.map((o) => o.path),
    ["a.txt", "b.txt", "extra.txt"],
  );
  assert.equal(lane(r, "restart", "T4", "--carry").exit, 0);
  // Unchanged contract: the entries exactly as they were, c.txt not put back.
  assert.deepEqual(ledgerOf(r.root, "T4").owned, old);
  // The contract now owns d.txt too: its owns plus the grant, the grant's entry as it was.
  assert.equal(lane(r, "hold", "T4", "--for", "later", "--note", "park").exit, 0);
  const tasks = readFileSync(join(r.root, "plan", "TASKS.md"), "utf8");
  commitFile(
    r.root,
    "plan/TASKS.md",
    tasks.replace("`c.txt`\n", "`c.txt`, `d.txt`\n"),
    "docs: own d",
  );
  assert.equal(lane(r, "restart", "T4", "--carry").exit, 0);
  const now = ledgerOf(r.root, "T4").owned;
  assert.deepEqual(
    now.map((o) => o.path),
    ["a.txt", "b.txt", "c.txt", "d.txt", "extra.txt"],
  );
  assert.deepEqual(now.at(-1), old.at(-1));
});

test("the progress line counts only the owner's OKs of passed gates, not answers given mid-round", () => {
  const r = repo();
  const out = lane(r, "start", "T4").json;
  commitFile(out.worktree, "a.txt", "a\n", "feat: a");
  writeFileSync(out.reportPath, "DONE\na\nused_memories: none\n");
  assert.equal(lane(r, "report", "T4").json.state, "held");
  const two = lane(r, "resume", "T4", "--note", "step 1 is fine").json;
  writeFileSync(two.reportPath, "NEEDS_CONTEXT\nwhich?\n");
  assert.equal(lane(r, "hold", "T4", "--for", "owner", "--note", "look").exit, 0);
  assert.equal(lane(r, "resume", "T4", "--note", "go on").exit, 0);
  assert.equal(lane(r, "hold", "T4", "--for", "later", "--note", "park").exit, 0);
  const res = lane(r, "restart", "T4", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(ledgerOf(r.root, "T4").holds.length, 2);
  assert.match(res.json.progress, /^1 owner OK\(s\) carried/);
});

test("a restart of a lane whose verifier failed it briefs the failing verdict's report first", () => {
  const r = repo();
  assert.equal(judged(r, "FAIL").next, "fix");
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  const verdictReport = ledgerOf(r.root, "T3").rounds.find((x) => x.role === "verify").reportPath;
  const res = lane(r, "restart", "T3", "--carry");
  assert.equal(res.exit, 0, res.stderr);
  const brief = readFileSync(res.json.brief, "utf8");
  const archived = verdictReport.replace("/runs/T3/", "/runs/.archive/T3.1/");
  assert.match(
    brief,
    /## The last verdict\n\nThe old lane's verifier returned FAIL\. Its report is /,
  );
  assert.ok(brief.includes(archived), brief);
  assert.equal(ledgerOf(r.root, "T3").carried.verdict.report, archived);
});
