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
function repo({ spec = SPEC, untracked = false, board = BOARD_MD } = {}) {
  const root = temp("restart-repo-");
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
  const diff = join(processDir(r.root), "runs", "T3.1", "restart", "uncommitted.diff");
  assert.deepEqual(ledger.carried, { commits: 1, files: 1, report, applied: true, diff });
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
  const base = ledgerOf(r.root, "T3.1").base.slice(0, 7);
  const diff = join(processDir(r.root), "runs", "T3.1", "restart", "uncommitted.diff");
  const steps = out.split("→ fix that, then: ")[1]?.trim().split("; ") ?? [];
  assert.deepEqual(
    steps.map((s) => s.replace(/^.*exec start T3 --root .*$/, "START")),
    [
      "git branch -m agentry/T3 agentry/T3.1",
      "START",
      `in its worktree git cherry-pick ${base}..agentry/T3.1`,
      `git apply --3way ${diff}`,
    ],
    out,
  );
  git(r.root, "branch", "-D", "agentry/T3.1/x"); // "fix that"
  git(r.root, "branch", "-m", "agentry/T3", "agentry/T3.1");
  assert.equal(tipOf(r.root, "agentry/T3.1"), oldTip);
  const started = lane(r, "start", "T3");
  assert.equal(started.exit, 0, started.stderr);
  git(started.json.worktree, "cherry-pick", `${base}..agentry/T3.1`);
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
    assert.equal(tipOf(r.root, "agentry/T3.1"), oldTip, "the kept branch survives");
    assert.match(readFileSync(diff, "utf8"), /\+\+\+ b\/more\.txt/);
    // The steps back, followed as printed, bring the commit and the uncommitted file back (r4 N9).
    const base = ledgerOf(r.root, "T3.1").base.slice(0, 7);
    const steps = out.split("→ fix that, then: ")[1]?.trim().split("; ") ?? [];
    assert.deepEqual(
      steps.map((s) => s.replace(/^.*exec start T3 --root .*$/, "START")),
      [
        "git branch -D agentry/T3",
        "START",
        `in its worktree git cherry-pick ${base}..agentry/T3.1`,
        `git apply --3way ${diff}`,
      ],
      out,
    );
    git(r.root, "branch", "-D", "agentry/T3");
    const started = lane(r, "start", "T3");
    assert.equal(started.exit, 0, started.stderr);
    git(started.json.worktree, "cherry-pick", `${base}..agentry/T3.1`);
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
  assert.equal(existsSync(ledgerFile(r.root, "T3.1")), false);
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
  assert.match(ledger.rounds[0].reportPath, /\/runs\/T3\.1\//);
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
  assert.match(round.reportPath, /\/runs\/T3\.1\//);
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
