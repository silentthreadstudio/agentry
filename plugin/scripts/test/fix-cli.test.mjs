// Tests for `board fix` (lib/process/cli/fix.mjs): it writes done only when provable (a merge record that
// still holds on main, or an owner's --accept whose change still reverse-applies), `--dry-run` writes
// nothing, a second run finds nothing, and what it cannot decide is reported. A property test walks random
// pick / revert / reset / squash / merge sequences and checks done is written only while the lines are on main.
// Run: node --test plugin/scripts/test/fix-cli.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { run as fix } from "../lib/process/cli/fix.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";
import {
  SPEC,
  board,
  boardRepo,
  builtBranch,
  handBranch,
  ledger,
  pickOntoMain,
  read,
} from "./drift-repo.mjs";
import { commitFile, git, gitEnv } from "./git-repo.mjs";

const cleanups = [];
after(() => {
  for (const c of cleanups) c();
});
// T1 is the task under test; T3 is already tracked, so the only nudges are the ones a test makes.
function fresh(opts) {
  const repo = boardRepo(opts);
  cleanups.push(repo.cleanup);
  ledger(repo.root, "T3");
  return repo;
}
const files = (root) => ({
  board: read(root, "plan/BOARD.md"),
  sprint: read(root, "plan/sprints/S1.md"),
});
const row = (text, id) => text.split("\n").find((l) => l.startsWith(`| ${id} `));

// T1 built on its branch and cherry-picked to main; a ledger with the merge record. Returns main's commit.
function landedWithRecord(root, id = "T1") {
  const { sha } = builtBranch(root, id);
  const main = pickOntoMain(root, sha);
  ledger(root, id, { state: "merged", merge: { preHead: "x", landed: [main], step: "done" } });
  return main;
}

test("a merged ledger and a board still at doing: fix writes done, the SHA and the handoff line", () => {
  const { root } = fresh();
  const main = landedWithRecord(root);
  const before = files(root);
  const out = board(root, "fix");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^fixed 1, 0 left for you/);
  const now = files(root);
  const short = main.slice(0, 7);
  assert.match(row(now.board, "T1"), new RegExp(`\\| done +\\| +\\| ${short} +\\|`));
  assert.equal(row(now.board, "T2"), row(before.board, "T2"));
  assert.equal(row(now.board, "T3"), row(before.board, "T3"));
  assert.match(now.sprint, new RegExp(`- \\*\\*T1\\*\\* \\(${short}\\): The first`));
  const check = board(root, "check");
  assert.equal(check.status, 0, check.stdout);
});

test("--dry-run writes nothing and says what it would fix", () => {
  const { root } = fresh();
  landedWithRecord(root);
  const before = files(root);
  const out = board(root, "fix", "--dry-run");
  assert.deepEqual(files(root), before);
  assert.match(out.stdout, /^would fix 1/);
  assert.match(out.stdout, /T1 +status, commit, handoff/);
  assert.equal(out.status, 0, "a task that would be fixed is not a task left for the owner");
});

test("a second run finds nothing to do and leaves the files as they were", () => {
  const { root } = fresh();
  landedWithRecord(root);
  board(root, "fix");
  const once = files(root);
  const again = board(root, "fix");
  assert.match(again.stdout, /^fixed 0, 0 left for you/);
  assert.deepEqual(files(root), once);
});

test("a hand cherry-pick (no merge record) is never written by fix alone: a nudge to --accept", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  pickOntoMain(root, sha);
  ledger(root, "T1");
  const before = files(root);
  const out = board(root, "fix");
  assert.deepEqual(files(root), before);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^fixed 0, 1 left for you/);
  assert.match(out.stdout, /merged-by-hand T1 → \/agentry:board --fix --accept T1/);
});

test("--accept <id> writes a hand cherry-pick (no merge record) with main's commit", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  const main = pickOntoMain(root, sha);
  ledger(root, "T1");
  const out = board(root, "fix", "--accept", "T1");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const short = main.slice(0, 7);
  assert.match(row(read(root, "plan/BOARD.md"), "T1"), new RegExp(`done +\\| +\\| ${short}`));
  assert.ok(!row(read(root, "plan/BOARD.md"), "T1").includes(sha.slice(0, 7)));
  assert.equal(board(root, "check").status, 0);
});

test("done with no SHA: fix adds the SHA and the handoff line and leaves the status", () => {
  const { root } = fresh();
  const main = landedWithRecord(root);
  const text = read(root, "plan/BOARD.md").replace(
    /^\| T1 .*$/m,
    "| T1   | S1     | done   |         |        | The first  |",
  );
  writeFileSync(join(root, "plan", "BOARD.md"), text);
  const out = board(root, "fix", "--json");
  const result = JSON.parse(out.stdout);
  assert.deepEqual(
    result.fixed.map((f) => f.need),
    [["commit", "handoff"]],
  );
  assert.match(
    row(read(root, "plan/BOARD.md"), "T1"),
    new RegExp(`done +\\| +\\| ${main.slice(0, 7)}`),
  );
});

test("a commit cell that names other commits is reported and left alone", () => {
  const { root } = fresh();
  landedWithRecord(root);
  const text = read(root, "plan/BOARD.md").replace(
    /^\| T1 .*$/m,
    "| T1   | S1     | doing  |         | abc1234 | The first  |",
  );
  writeFileSync(join(root, "plan", "BOARD.md"), text);
  const before = files(root);
  const out = board(root, "fix");
  assert.equal(out.status, 1);
  assert.match(out.stdout, /T1: commit cell "abc1234" is not the landed \w+; left alone/);
  assert.deepEqual(files(root), before);
});

// The board as a hand left it: `cells` replaces T1's row from its Status column on.
function handRow(root, cells) {
  const text = read(root, "plan/BOARD.md").replace(/^\| T1 .*$/m, `| T1   | S1     | ${cells}`);
  writeFileSync(join(root, "plan", "BOARD.md"), text);
}
// T1 built and cherry-picked by hand, its ledger left at verified (no merge record).
function pickedByHand(root) {
  const { sha } = builtBranch(root, "T1");
  const main = pickOntoMain(root, sha);
  ledger(root, "T1", { state: "verified" });
  return main;
}
// The owner confirms T1's hand merge.
const accept = (root, ...more) => board(root, "fix", "--accept", "T1", ...more);

test("work picked onto main and then reverted is never written as done", () => {
  for (const record of [false, true]) {
    const { root } = fresh();
    const { sha } = builtBranch(root, "T1");
    const main = pickOntoMain(root, sha);
    git(root, "revert", "--no-edit", main);
    const merge = { preHead: "x", landed: [main], step: "done" };
    ledger(root, "T1", record ? { state: "merged", merge } : { state: "verified" });
    const before = files(root);
    for (const out of [board(root, "fix"), accept(root)]) {
      assert.deepEqual(files(root), before, record ? "with a merge record" : "picked by hand");
      assert.match(out.stdout, /^fixed 0/);
      assert.equal(out.status, 1);
    }
  }
});

test("--accept refuses a squash: its change is on main but no commit there can be named", () => {
  const { root } = fresh();
  const { path, branch } = builtBranch(root, "T1");
  commitFile(path, "T1b.txt", "second\n", "feat: T1 second");
  git(root, "merge", "--squash", branch);
  git(root, "commit", "-q", "-m", "squash T1");
  ledger(root, "T1", { state: "verified" });
  const before = files(root);
  const out = accept(root);
  assert.deepEqual(files(root), before);
  assert.match(out.stdout, /T1: on main, but no commit there matches its own \(squashed\?\)/);
  assert.equal(out.status, 1);
});

test("--accept needs a ledger for the id, and an id", () => {
  const { root } = fresh();
  const out = board(root, "fix", "--accept", "T2");
  assert.match(out.stdout, /T2: no ledger names its branch; nothing to accept/);
  assert.equal(out.status, 1);
  assert.equal(board(root, "fix", "--accept").status, 2);
});

test("a merge record reset off main is unsure, even with its commits still in the repo", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  const before = git(root, "rev-parse", "HEAD");
  const main = pickOntoMain(root, sha);
  ledger(root, "T1", { state: "merged", merge: { preHead: before, landed: [main], step: "done" } });
  git(root, "reset", "-q", "--hard", before);
  git(root, "merge", "-q", "--no-ff", "--no-edit", main); // the commit is back, but not first-parent
  const out = board(root, "fix");
  assert.match(out.stdout, /^fixed 0/);
  assert.match(out.stdout, /T1: merged, but those commits are undone on main/);
});

test("a hand-written commit cell is never rewritten: reported, and nothing else written", () => {
  const { root } = fresh();
  pickedByHand(root);
  handRow(root, "doing  |         | see PR 12 | The first  |");
  const before = files(root);
  const out = accept(root);
  assert.deepEqual(files(root), before);
  assert.match(out.stdout, /T1: commit cell "see PR 12" is not the landed \w{7}; left alone/);
  assert.equal(out.status, 1);
});

test("a cell naming the first of two landed commits is not extended", () => {
  const { root } = fresh();
  const { path, sha } = builtBranch(root, "T1");
  const second = commitFile(path, "T1b.txt", "second\n", "feat: T1 second");
  const first = pickOntoMain(root, sha);
  git(root, "cherry-pick", second);
  ledger(root, "T1", { state: "verified" });
  handRow(root, `doing  |         | ${first.slice(0, 7)} | The first  |`);
  const out = accept(root);
  assert.equal(out.status, 0, out.stdout);
  assert.match(
    row(read(root, "plan/BOARD.md"), "T1"),
    new RegExp(`done +\\| +\\| ${first.slice(0, 7)} \\|`),
  );
  assert.match(
    read(root, "plan/sprints/S1.md"),
    new RegExp(`\\*\\*T1\\*\\* \\(${first.slice(0, 7)}\\)`),
  );
});

test("a handoff line already there for the task (any form) is not added again", () => {
  const { root } = fresh();
  const main = pickedByHand(root);
  const sprint = `# S1\n\n## Handoff\n\n- Landed by hand in ${main.slice(0, 7)}: T1.\n\n## Notes\n\nNothing yet.\n`;
  writeFileSync(join(root, "plan", "sprints", "S1.md"), sprint);
  const out = accept(root, "--json");
  assert.equal(read(root, "plan/sprints/S1.md"), sprint);
  const [fixed] = JSON.parse(out.stdout).fixed;
  assert.deepEqual(fixed.writes, ["status → done", `commit → ${main.slice(0, 7)}`]);
});

test("a merge record's task with a hand handoff line naming it gets no second line", () => {
  const { root } = fresh();
  const main = landedWithRecord(root);
  const sprint = `# S1\n\n## Handoff\n\n- shipped T1 (see ${main.slice(0, 7)})\n`;
  writeFileSync(join(root, "plan", "sprints", "S1.md"), sprint);
  const [fixed] = JSON.parse(board(root, "fix", "--json").stdout).fixed;
  assert.deepEqual(fixed.need, ["status", "commit"]);
  assert.equal(read(root, "plan/sprints/S1.md"), sprint);
});

test("a status the lifecycle never sets before a merge is left alone and reported", () => {
  const { root } = fresh();
  pickedByHand(root);
  handRow(root, "todo   |         |        | The first  |");
  const before = files(root);
  const out = accept(root);
  assert.deepEqual(files(root), before);
  assert.match(out.stdout, /T1: on main \(\w{7}\), but status "todo" is set by hand; left alone/);
});

test("the output lists exactly the writes made, and the run after a fix exits 0", () => {
  const { root } = fresh();
  const main = pickedByHand(root);
  const out = accept(root);
  const short = main.slice(0, 7);
  assert.equal(
    out.stdout,
    `fixed 1, 0 left for you\n  T1  status → done, commit → ${short}, handoff line under "Handoff"\n`,
  );
  assert.equal(out.status, 0, "the verified ledger's work is on main: no stale nudge is left");
  assert.equal(git(root, "diff", "--numstat"), "1\t1\tplan/BOARD.md\n2\t0\tplan/sprints/S1.md");
  assert.match(board(root, "fix").stdout, /^fixed 0, 0 left for you/, "and fix then has nothing");
});

test("a ledgered branch merged by hand with --no-ff or fast-forwarded is accepted with its commit", () => {
  for (const how of [["--no-ff", "--no-edit"], ["--ff-only"]]) {
    const { root } = fresh();
    const { branch, sha } = builtBranch(root, "T1");
    if (how[0] === "--no-ff") commitFile(root, "m.txt", "main moved\n", "chore: move");
    git(root, "merge", ...how, branch);
    ledger(root, "T1", { state: "verified" });
    const out = accept(root);
    assert.equal(out.status, 0, `${how[0]}: ${out.stdout}`);
    assert.match(
      row(read(root, "plan/BOARD.md"), "T1"),
      new RegExp(`done +\\| +\\| ${sha.slice(0, 7)}`),
    );
  }
});

test("what is not mechanical is listed with its command, and the exit is 1", () => {
  const { root } = fresh();
  handBranch(root, ".claude/worktrees/agent-z9", "worktree-agent-z9");
  const out = board(root, "fix");
  assert.equal(out.status, 1);
  assert.match(out.stdout, /left for you:/);
  assert.match(out.stdout, /unlisted-worktree agent-z9 → \/agentry:exec <id>/);
  assert.match(out.stdout, /started-by-hand T1 → \/agentry:exec T1/);
  assert.equal(out.stdout.split("\n").filter((l) => /^ {2}\w/.test(l)).length, 2);
});

test("a merge in progress is not touched", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  const main = pickOntoMain(root, sha);
  ledger(root, "T1", { state: "merging", merge: { preHead: "x", landed: [main], step: "gate" } });
  const before = files(root);
  board(root, "fix");
  assert.deepEqual(files(root), before);
});

test("without a lifecycle fix writes nothing and has nothing to report", () => {
  const { lifecycle, ...bare } = SPEC;
  assert.ok(lifecycle);
  const { root } = fresh({ spec: bare });
  landedWithRecord(root);
  const before = files(root);
  const out = board(root, "fix");
  assert.equal(out.status, 0, out.stdout);
  assert.deepEqual(files(root), before);
});

test("fix takes no operands", () => {
  const { root } = fresh();
  const out = board(root, "fix", "--bogus");
  assert.equal(out.status, 2);
});

// ---- property: done is written only while the task's lines are on main ----

// A seeded generator (mulberry32), so a failing walk can be replayed from its seed.
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// git that may fail (a conflict, nothing to commit); a failed step is undone and the walk goes on.
function attempt(root, ...args) {
  const ok = spawnSync("git", ["-C", root, ...args], { env: gitEnv }).status === 0;
  if (!ok) {
    for (const op of ["cherry-pick", "revert", "merge"])
      spawnSync("git", ["-C", root, op, "--abort"], { env: gitEnv });
    git(root, "reset", "-q", "--hard", "HEAD");
  }
  return ok;
}
const firstParents = (root) => git(root, "rev-list", "--first-parent", "main").split("\n");
const isMerge = (root, sha) => git(root, "rev-list", "--parents", "-n1", sha).split(" ").length > 2;

// One step on main: pick / land (a pick with a `lane merge` record) / revert / revert -m 1 / reset /
// squash / no-ff, or a hand edit that takes the task's file out. Main moves on first half the time.
function step(root, { pick, branch, fork, step: n }) {
  if (pick() < 0.5) commitFile(root, `m${n}.txt`, `main ${n}\n`, `chore: main ${n}`);
  const ops = ["land", "pick", "revert", "revert-m", "reset", "squash", "no-ff", "hand"];
  const op = ops[Math.floor(pick() * ops.length)];
  const history = firstParents(root).slice(0, -1); // never the root commit
  const choose = (list) => list[Math.floor(pick() * list.length)];
  if (op === "land" || op === "pick") {
    const preHead = git(root, "rev-parse", "HEAD");
    if (!attempt(root, "cherry-pick", `${fork}..${branch}`) || op === "pick") return op;
    const landed = git(root, "rev-list", "--reverse", `${preHead}..HEAD`).split("\n");
    ledger(root, "T1", { state: "merged", merge: { preHead, landed, step: "done" } });
  } else if (op === "revert") {
    const sha = choose(history.filter((s) => !isMerge(root, s)));
    if (sha) attempt(root, "revert", "--no-edit", sha);
  } else if (op === "revert-m") {
    const sha = choose(history.filter((s) => isMerge(root, s)));
    if (sha) attempt(root, "revert", "--no-edit", "-m", "1", sha);
  } else if (op === "reset") {
    git(root, "reset", "-q", "--hard", choose(firstParents(root)));
  } else if (op === "squash") {
    if (attempt(root, "merge", "--squash", branch)) attempt(root, "commit", "-q", "-m", "squash");
  } else if (op === "no-ff") {
    attempt(root, "merge", "--no-ff", "--no-edit", branch);
  } else if (attempt(root, "rm", "-q", "T1.txt")) {
    git(root, "commit", "-q", "-m", "drop T1 by hand");
  }
  return op;
}

// Every line of every file the branch changed is in main's copy of that file.
function linesOnMain(root, { fork, branch }) {
  const changed = git(root, "diff", "--name-only", fork, branch).split("\n").filter(Boolean);
  return changed.every((file) => {
    const theirs = spawnSync("git", ["-C", root, "show", `main:${file}`], { encoding: "utf8" });
    const lines = theirs.stdout.split("\n");
    return (
      theirs.status === 0 &&
      git(root, "show", `${branch}:${file}`)
        .split("\n")
        .every((l) => lines.includes(l))
    );
  });
}

function fixIn(root, argv) {
  const { spec } = loadSpec(join(root, ".agentry", "process.json"), { root });
  return fix(argv, { root, spec, model: readProcess({ root, spec }) });
}
const isDone = (root) => /^\| T1 +\| S1 +\| done /.test(row(read(root, "plan/BOARD.md"), "T1"));

test("property: random pick/revert/reset/squash/no-ff/revert -m 1 walks write done only when on main", () => {
  const done = { record: 0, accept: 0, refused: 0 };
  for (let seed = 1; seed <= 30; seed++) {
    const pick = random(seed);
    const { root } = fresh();
    const fork = git(root, "rev-parse", "HEAD");
    const { path, branch } = builtBranch(root, "T1");
    if (pick() < 0.5) commitFile(path, "T1.txt", "work of T1\nmore of T1\n", "feat: T1 more");
    if (pick() < 0.5) commitFile(path, "T1b.txt", "second\n", "feat: T1 second");
    ledger(root, "T1", { state: "verified" });
    const ops = [];
    const walk = { pick, branch, fork };
    for (let n = 0, steps = 1 + Math.floor(pick() * 5); n < steps; n++)
      ops.push(step(root, { ...walk, step: n }));
    const on = linesOnMain(root, walk);
    const why = `seed ${seed}: ${ops.join(" → ")}`;
    fixIn(root, []);
    if (isDone(root)) {
      assert.ok(on, `fix wrote done with the lines off main (${why})`);
      done.record++;
      continue;
    }
    fixIn(root, ["--accept", "T1"]);
    assert.ok(!isDone(root) || on, `--accept wrote done with the lines off main (${why})`);
    if (isDone(root)) done.accept++;
    else if (on) done.refused++;
  }
  // The walks reach every outcome: proven by a record, accepted, and on main but not provable.
  assert.ok(done.record && done.accept && done.refused, JSON.stringify(done));
});
