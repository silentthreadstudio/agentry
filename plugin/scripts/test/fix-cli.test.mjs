// Tests for `board fix` (lib/process/cli/fix.mjs): it writes done only when provable (a merge record that
// still holds on main, or an owner's --accept whose change is still in effect), without `--apply` it writes nothing,
// a second run finds nothing, and what it cannot decide is reported. A property test walks random pick /
// revert / reset / squash / merge / chmod sequences and checks done is written only while main's copy of
// the task's files is the branch's, mode and bytes. By default it walks a few seeds that between them reach
// every outcome; AGENTRY_PROPERTY_FULL=1 walks all 40 (slow: run it after touching inEffect).
// Run: node --test plugin/scripts/test/fix-cli.test.mjs
//      AGENTRY_PROPERTY_FULL=1 node --test --test-name-pattern=property plugin/scripts/test/fix-cli.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
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
  mergeOntoMain,
  mergeRecord,
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

// A file whose 7-line block repeats: `git apply` finds a reverted hunk's lines and context in the other
// copy, so only a position-exact check tells the revert. `add`: the task adds X to the block that lacks
// it; `drop`: it takes X out of the block that has it. Committed on main before the branch is cut.
const BLOCK = "p\nq\nr\nX\ns\nt\nu\n";
const BARE = "p\nq\nr\ns\nt\nu\n";
const REPEATED = {
  add: { before: `${BLOCK}---\n${BARE}`, after: `${BLOCK}---\n${BLOCK}` },
  drop: { before: `${BARE}---\n${BLOCK}`, after: `${BARE}---\n${BARE}` },
};

// T1 built on its branch and landed on main as `lane merge` does, with its record. Returns main's commit.
function landedWithRecord(root, id = "T1") {
  const { sha } = builtBranch(root, id);
  return mergeOntoMain(root, id, [sha])[0];
}

test("a merged ledger and a board still at doing: fix writes done, the SHA and the handoff line", () => {
  const { root } = fresh();
  const main = landedWithRecord(root);
  const before = files(root);
  const out = board(root, "fix", "--apply");
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

test("without --apply it writes nothing and says what it would fix", () => {
  const { root } = fresh();
  landedWithRecord(root);
  const before = files(root);
  const out = board(root, "fix");
  assert.deepEqual(files(root), before);
  assert.match(out.stdout, /^would fix 1/);
  assert.match(out.stdout, /T1 +status, commit, handoff/);
  assert.equal(out.status, 0, "a task that would be fixed is not a task left for the owner");
});

test("a second run finds nothing to do and leaves the files as they were", () => {
  const { root } = fresh();
  landedWithRecord(root);
  board(root, "fix", "--apply");
  const once = files(root);
  const again = board(root, "fix", "--apply");
  assert.match(again.stdout, /^fixed 0, 0 left for you/);
  assert.deepEqual(files(root), once);
});

test("a hand cherry-pick (no merge record) is never written by fix alone: a nudge to --accept", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  pickOntoMain(root, sha);
  ledger(root, "T1");
  const before = files(root);
  const out = board(root, "fix", "--apply");
  assert.deepEqual(files(root), before);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^fixed 0, 1 left for you/);
  assert.match(out.stdout, /merged-by-hand T1 → \/agentry:board fix --accept T1/);
});

test("--accept <id> writes a hand cherry-pick (no merge record) with main's commit", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  const main = pickOntoMain(root, sha);
  ledger(root, "T1");
  const out = board(root, "fix", "--apply", "--accept", "T1");
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
  const out = board(root, "fix", "--apply", "--json");
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
  const out = board(root, "fix", "--apply");
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
const accept = (root, ...more) => board(root, "fix", "--apply", "--accept", "T1", ...more);

test("work picked onto main and then reverted is never written as done", () => {
  for (const record of [false, true]) {
    const { root } = fresh();
    const { sha } = builtBranch(root, "T1");
    const main = pickOntoMain(root, sha);
    git(root, "revert", "--no-edit", main);
    const merge = mergeRecord(git(root, "rev-parse", `${main}^`), [sha], [main]);
    ledger(root, "T1", record ? { state: "merged", merge } : { state: "verified" });
    const before = files(root);
    for (const out of [board(root, "fix", "--apply"), accept(root)]) {
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
  const out = board(root, "fix", "--apply", "--accept", "T2");
  assert.match(out.stdout, /T2: no ledger names its branch; nothing to accept/);
  assert.equal(out.status, 1);
  assert.equal(board(root, "fix", "--apply", "--accept").status, 2);
});

test("a merge record reset off main is unsure, even with its commits still in the repo", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  const before = git(root, "rev-parse", "HEAD");
  const [main] = mergeOntoMain(root, "T1", [sha]);
  git(root, "reset", "-q", "--hard", before);
  git(root, "merge", "-q", "--no-ff", "--no-edit", main); // the commit is back, but not first-parent
  const out = board(root, "fix", "--apply");
  assert.match(out.stdout, /^fixed 0/);
  assert.match(out.stdout, /T1: merged, but those commits are no longer main's history/);
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

// T1's branch: one commit of its own file, then its change to `file` (`text`). The two commits, oldest first.
function taskChanging(root, file, text) {
  const { path, sha } = builtBranch(root, "T1", "unused.txt");
  return [sha, commitFile(path, file, text, `feat: T1 changes ${file}`)];
}
// The same, for a change to a file whose block repeats (`REPEATED`).
function repeatedTask(root, shape) {
  commitFile(root, "rep.txt", REPEATED[shape].before, "chore: a repeated block");
  return taskChanging(root, "rep.txt", REPEATED[shape].after);
}

test("a revert is seen where the task's lines were, even where the same lines repeat in the file", () => {
  for (const shape of ["add", "drop"]) {
    const { root } = fresh();
    const [, two] = mergeOntoMain(root, "T1", repeatedTask(root, shape));
    assert.equal(board(root, "fix").status, 0, `${shape}: holds at first`);
    git(root, "revert", "--no-edit", two);
    const before = files(root);
    const out = board(root, "fix", "--apply");
    assert.deepEqual(files(root), before, `${shape}: nothing written`);
    assert.match(out.stdout, /^fixed 0, 1 left/, shape);
    assert.match(out.stdout, /T1: merged, but .*rep\.txt/, shape);
  }
});

test("--accept refuses a hand pick reverted on a file whose lines repeat", () => {
  for (const shape of ["add", "drop"]) {
    const { root } = fresh();
    const [first, second] = repeatedTask(root, shape);
    pickOntoMain(root, first);
    git(root, "cherry-pick", second);
    git(root, "revert", "--no-edit", "HEAD");
    ledger(root, "T1", { state: "verified" });
    const before = files(root);
    const out = accept(root);
    assert.deepEqual(files(root), before, shape);
    assert.match(out.stdout, /T1: its branch's change is not all on main/, shape);
  }
});

test("a re-added line is a new line: a record whose lines went and came back is unsure", () => {
  const { root } = fresh();
  commitFile(root, "src.txt", "a\nb\nc\n", "chore: src");
  mergeOntoMain(root, "T1", taskChanging(root, "src.txt", "a\nb\nNEW\nc\n"));
  commitFile(root, "src.txt", "a\nb\nc\n", "chore: drop it by hand");
  commitFile(root, "src.txt", "top\na\nb\nNEW\nc\n", "chore: type it back, and more");
  const out = board(root, "fix", "--apply");
  assert.match(out.stdout, /^fixed 0/);
  assert.match(out.stdout, /T1: merged, but the line it added at src\.txt:3 is not there now/);
});

test("a revert of the revert leaves the file byte for byte as it landed: done", () => {
  const { root } = fresh();
  commitFile(root, "src.txt", "a\nb\nc\n", "chore: src");
  const [, two] = mergeOntoMain(root, "T1", taskChanging(root, "src.txt", "a\nb\nNEW\nc\n"));
  git(root, "revert", "--no-edit", two);
  assert.match(board(root, "fix").stdout, /^would fix 0/);
  git(root, "revert", "--no-edit", "HEAD");
  assert.match(board(root, "fix", "--apply").stdout, /^fixed 1, 0 left/);
});

test("a later commit next to a line the task added leaves it done, and rewriting the line does not", () => {
  const setup = () => {
    const { root } = fresh();
    commitFile(root, "ctx.txt", "a\nb\nc\nd\ne\nf\n", "chore: ctx");
    mergeOntoMain(root, "T1", taskChanging(root, "ctx.txt", "a\nb\nc\nNEW\nd\ne\nf\n"));
    return root;
  };
  const near = setup();
  commitFile(near, "ctx.txt", "a\nb\nC2\nNEW\nd\ne\nf\n", "feat: T2 edits its neighbour");
  assert.match(board(near, "fix", "--apply").stdout, /^fixed 1, 0 left/);
  const over = setup();
  commitFile(over, "ctx.txt", "a\nb\nc\nNEWER\nd\ne\nf\n", "feat: T2 rewrites the line");
  assert.match(
    board(over, "fix", "--apply").stdout,
    /line it added at ctx\.txt:4 is not there now/,
  );
});

test("a later edit around a line the task removed is unsure and says so, not that it was reverted", () => {
  const { root } = fresh();
  commitFile(root, "ctx.txt", "a\nb\nOLD\nc\nd\n", "chore: ctx");
  mergeOntoMain(root, "T1", taskChanging(root, "ctx.txt", "a\nb\nc\nd\n"));
  commitFile(root, "ctx.txt", "a\nB2\nc\nd\n", "feat: T2 edits its neighbour");
  const out = board(root, "fix", "--apply");
  assert.match(out.stdout, /^fixed 0/);
  assert.match(out.stdout, /lines around its change at ctx\.txt:2 were edited since/);
  assert.doesNotMatch(out.stdout, /reverted/);
});

test("a line the task added beside its twin: a revert that removes either copy is caught", () => {
  const { root } = fresh();
  commitFile(root, "twin.txt", "a\nX\nb\n", "chore: twin");
  const [, two] = mergeOntoMain(root, "T1", taskChanging(root, "twin.txt", "a\nX\nX\nb\n"));
  git(root, "revert", "--no-edit", two);
  const out = board(root, "fix", "--apply");
  assert.match(out.stdout, /^fixed 0/);
  assert.match(out.stdout, /twin\.txt/);
});

test("a binary or empty file the task added is checked by its content", () => {
  const { root } = fresh();
  const { path, sha } = builtBranch(root, "T1");
  writeFileSync(join(path, "b.bin"), Buffer.from([0, 1, 2, 0, 3]));
  writeFileSync(join(path, "empty.txt"), "");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "feat: T1 binary and empty");
  mergeOntoMain(root, "T1", [sha, git(path, "rev-parse", "HEAD")]);
  git(root, "rm", "-q", "empty.txt");
  git(root, "commit", "-q", "-m", "chore: drop the empty file");
  const out = board(root, "fix", "--apply");
  assert.match(out.stdout, /^fixed 0/);
  assert.match(out.stdout, /T1: merged, but empty\.txt is not as it landed/);
});

test("a mode-only change reverted on main is never written as done", () => {
  const { root } = fresh();
  commitFile(root, "run.sh", "echo hi\n", "chore: a script");
  const { path, sha } = builtBranch(root, "T1");
  chmodSync(join(path, "run.sh"), 0o755);
  git(path, "add", "run.sh");
  git(path, "commit", "-q", "-m", "feat: T1 makes run.sh executable");
  const [, landed] = mergeOntoMain(root, "T1", [sha, git(path, "rev-parse", "HEAD")]);
  assert.match(board(root, "fix").stdout, /^would fix 1/, "holds while it is +x");
  git(root, "revert", "--no-edit", landed);
  const before = files(root);
  const out = board(root, "fix", "--apply");
  assert.deepEqual(files(root), before);
  assert.match(out.stdout, /^fixed 0/);
  assert.match(out.stdout, /T1: merged, but run\.sh is not as it landed/);
});

test("a removed block retyped elsewhere in the file is never written as done", () => {
  const { root } = fresh();
  const body = "function old() {\n  return 1;\n}\n";
  commitFile(root, "src.js", `a\n${body}b\nc\n`, "chore: src");
  mergeOntoMain(root, "T1", taskChanging(root, "src.js", "a\nb\nc\n"));
  commitFile(root, "src.js", `a\nb\nc\n${body}`, "chore: put old() back at the end");
  const out = board(root, "fix", "--apply");
  assert.match(out.stdout, /^fixed 0/);
  assert.match(out.stdout, /T1: merged, but a line it removed from src\.js is back/);
});

test("a record not about the ledger's branch is unsure: an unrelated commit, or only part of the branch", () => {
  const unrelated = fresh().root;
  const other = commitFile(unrelated, "other.txt", "o\n", "feat: someone else");
  const one = builtBranch(unrelated, "T1");
  ledger(unrelated, "T1", {
    state: "merged",
    merge: mergeRecord(git(unrelated, "rev-parse", `${other}^`), [one.sha], [other]),
  });
  assert.match(
    board(unrelated, "fix", "--apply").stdout,
    /T1: merged, but its merge record does not match/,
  );

  const part = fresh().root;
  const two = builtBranch(part, "T1");
  commitFile(two.path, "T1b.txt", "b\n", "feat: T1 second");
  const [landed] = mergeOntoMain(part, "T1", [two.sha]);
  assert.ok(landed);
  assert.match(
    board(part, "fix", "--apply").stdout,
    /T1: merged, but its merge record does not match/,
  );
});

test("a record with no plan of what it picked is unsure", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  const [main] = mergeOntoMain(root, "T1", [sha]);
  const preHead = git(root, "rev-parse", `${main}^`);
  ledger(root, "T1", { state: "merged", merge: { preHead, landed: [main], step: "done" } });
  assert.match(board(root, "fix", "--apply").stdout, /its merge record does not match/);
});

test("a record whose branch was cleaned up still holds, by the tip it wrote at the land", () => {
  const { root } = fresh();
  const { path, branch, sha } = builtBranch(root, "T1");
  const [main] = mergeOntoMain(root, "T1", [sha]);
  git(root, "worktree", "remove", "-f", path);
  git(root, "branch", "-D", branch);
  const out = board(root, "fix", "--apply");
  assert.match(out.stdout, /^fixed 1, 0 left/, out.stdout);
  assert.ok(read(root, "plan/BOARD.md").includes(main.slice(0, 7)));
});

test("--accept takes a branch that merged main in and was then merged --no-ff", () => {
  const { root } = fresh();
  const { path, branch, sha } = builtBranch(root, "T1");
  commitFile(root, "mv.txt", "x\n", "chore: main moves on");
  git(path, "merge", "--no-edit", "main");
  git(root, "merge", "--no-ff", "--no-edit", branch);
  ledger(root, "T1", { state: "verified" });
  const out = accept(root);
  assert.equal(out.status, 0, out.stdout);
  assert.match(
    row(read(root, "plan/BOARD.md"), "T1"),
    new RegExp(`done +\\| +\\| ${sha.slice(0, 7)}`),
  );
});

test("a long id wraps the row: the command is whole and no line is wider than 80 columns", () => {
  const { root } = fresh();
  const long = "R1b-6-board-fix-drafts-and-nudges-round-three-really-long-id";
  const text = read(root, "plan/BOARD.md").replace(
    "| T2   | S1     | todo   |",
    `| ${long} | S1 | doing |`,
  );
  writeFileSync(join(root, "plan", "BOARD.md"), text);
  const out = board(root, "fix", "--apply");
  assert.ok(!out.stdout.includes("…"), out.stdout);
  assert.ok(out.stdout.replaceAll(/\s+/g, " ").includes(`/agentry:exec ${long}`), out.stdout);
  for (const line of out.stdout.split("\n")) assert.ok([...line].length <= 80, line);
});

const sprintWith = (root, lines) =>
  writeFileSync(
    join(root, "plan", "sprints", "S1.md"),
    `# S1\n\n## Handoff\n\n${lines}\n## Notes\n\nNothing yet.\n`,
  );

test("a hand handoff line board check accepts is not added again", () => {
  const { root } = fresh();
  const main = pickedByHand(root);
  sprintWith(root, `- **T1** (${main.slice(0, 7)}): landed by hand\n`);
  const sprint = read(root, "plan/sprints/S1.md");
  const out = accept(root, "--json");
  assert.equal(read(root, "plan/sprints/S1.md"), sprint);
  const [fixed] = JSON.parse(out.stdout).fixed;
  assert.deepEqual(fixed.writes, ["status → done", `commit → ${main.slice(0, 7)}`]);
  assert.equal(board(root, "check").status, 0);
});

test("a line board check does not count as T1's handoff gets T1 its own line, and check is green", () => {
  const shapes = [
    (sha) => `- shipped T1 (see ${sha})\n`, // plain, no bold lead
    () => "- **T2** (abcdef1): builds on T1 once it lands\n", // another task's line
    () => "- **T10** (abcdef1): ten\n- see T1-b\n", // ids that only start like it
    () => "- **T1**: landed, no commit named\n", // the rule asks for the first commit
  ];
  for (const shape of shapes) {
    const { root } = fresh();
    const main = landedWithRecord(root);
    sprintWith(root, shape(main.slice(0, 7)));
    git(root, "commit", "-qam", "a hand line");
    const [fixed] = JSON.parse(board(root, "fix", "--apply", "--json").stdout).fixed;
    assert.deepEqual(fixed.need, ["status", "commit", "handoff"], shape("<sha>"));
    const check = board(root, "check");
    assert.equal(check.status, 0, `${shape("<sha>")}${check.stdout}`);
    assert.match(board(root, "fix", "--apply").stdout, /^fixed 0, 0 left for you/);
  }
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
  assert.match(
    board(root, "fix", "--apply").stdout,
    /^fixed 0, 0 left for you/,
    "and fix then has nothing",
  );
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
  const out = board(root, "fix", "--apply");
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
  board(root, "fix", "--apply");
  assert.deepEqual(files(root), before);
});

test("without a lifecycle fix writes nothing and has nothing to report", () => {
  const { lifecycle, ...bare } = SPEC;
  assert.ok(lifecycle);
  const { root } = fresh({ spec: bare });
  landedWithRecord(root);
  const before = files(root);
  const out = board(root, "fix", "--apply");
  assert.equal(out.status, 0, out.stdout);
  assert.deepEqual(files(root), before);
});

test("fix takes no operands", () => {
  const { root } = fresh();
  const out = board(root, "fix", "--apply", "--bogus");
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
// squash / no-ff, or a hand edit that takes the task's file out or clears run.sh's executable bit. Main
// moves on first half the time. Lands and reverts come up most, so a walk often ends on the revert of a
// landed commit.
function step(root, { pick, branch, fork, created, step: n }) {
  if (pick() < 0.5) commitFile(root, `m${n}.txt`, `main ${n}\n`, `chore: main ${n}`);
  const ops = ["land", "land", "land", "pick", "revert", "revert", "revert", "revert"];
  ops.push("revert-m", "reset", "squash", "no-ff", "hand", "chmod");
  if (created) ops.push("chmod", "chmod", "chmod", "chmod"); // the file the task created, hand-chmodded
  const op = ops[Math.floor(pick() * ops.length)];
  const history = firstParents(root).slice(0, -1); // never the root commit
  const choose = (list) => list[Math.floor(pick() * list.length)];
  if (op === "land" || op === "pick") {
    const preHead = git(root, "rev-parse", "HEAD");
    if (!attempt(root, "cherry-pick", `${fork}..${branch}`) || op === "pick") return op;
    const landed = git(root, "rev-list", "--reverse", `${preHead}..HEAD`).split("\n");
    const planned = git(root, "rev-list", "--reverse", `${fork}..${branch}`).split("\n");
    ledger(root, "T1", { state: "merged", merge: mergeRecord(preHead, planned, landed) });
  } else if (op === "revert") {
    // Most reverts hit a commit that touched the task's files: the one shape a text match can miss.
    const changed = git(root, "diff", "--name-only", fork, branch).split("\n");
    const touching = git(
      root,
      "rev-list",
      "--first-parent",
      "--no-merges",
      "main",
      "--",
      ...changed,
    );
    const task = touching.split("\n").filter((s) => s && history.includes(s));
    const plain = history.filter((s) => !isMerge(root, s));
    const sha = choose(task.length && pick() < 0.8 ? task : plain);
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
  } else if (op === "chmod") {
    if (!existsSync(join(root, "run.sh"))) return op;
    chmodSync(join(root, "run.sh"), 0o644);
    if (attempt(root, "add", "run.sh"))
      attempt(root, "commit", "-q", "-m", "chore: run.sh not executable by hand");
  } else if (attempt(root, "rm", "-q", "T1.txt")) {
    git(root, "commit", "-q", "-m", "drop T1 by hand");
  }
  return op;
}

// The oracle, position-exact: nothing on main but the task's own commits (picked, merged, squashed,
// reverted, reset) and the hand edits touch the files the branch changed, so its change is on main exactly
// when main's entry for each such file is the branch's: the same mode and blob (absent on both counts).
function onMain(root, { fork, branch }) {
  const changed = git(root, "diff", "--name-only", fork, branch).split("\n").filter(Boolean);
  const entry = (ref, file) => git(root, "ls-tree", ref, "--", file);
  return changed.every((file) => entry("main", file) === entry(branch, file));
}

function fixIn(root, argv) {
  const { spec } = loadSpec(join(root, ".agentry", "process.json"), { root });
  return fix(argv, { root, spec, model: readProcess({ root, spec }) });
}
const isDone = (root) => /^\| T1 +\| S1 +\| done /.test(row(read(root, "plan/BOARD.md"), "T1"));

// The seeds walked: all of them under AGENTRY_PROPERTY_FULL=1, else a few that between them reach every
// outcome (proven by a record, accepted, refused while on main) and a task that sets a mode.
const SEEDS = process.env.AGENTRY_PROPERTY_FULL
  ? Array.from({ length: 40 }, (_, i) => i + 1)
  : [4, 13, 17, 20, 27, 36];

test("property: random pick/revert/reset/squash/no-ff/revert -m 1/chmod walks write done only when on main", () => {
  const done = { record: 0, accept: 0, refused: 0 };
  for (const seed of SEEDS) {
    const pick = random(seed);
    const { root } = fresh();
    const shape = [null, "add", "drop", "mode"][Math.floor(pick() * 4)];
    // A task that sets a mode sets it on a script already there, or on one it creates (even seeds).
    const created = shape === "mode" && seed % 2 === 0;
    if (shape === "mode" && !created) commitFile(root, "run.sh", "echo T1\n", "chore: a script");
    else if (shape && shape !== "mode")
      commitFile(root, "rep.txt", REPEATED[shape].before, "chore: a repeated block");
    const fork = git(root, "rev-parse", "HEAD");
    const { path, branch } = builtBranch(root, "T1");
    if (pick() < 0.5) commitFile(path, "T1.txt", "work of T1\nmore of T1\n", "feat: T1 more");
    if (pick() < 0.5) commitFile(path, "T1b.txt", "second\n", "feat: T1 second");
    if (shape === "mode") {
      if (created) writeFileSync(join(path, "run.sh"), "echo T1\n");
      chmodSync(join(path, "run.sh"), 0o755);
      git(path, "add", "run.sh");
      git(path, "commit", "-q", "-m", "feat: T1 makes run.sh executable");
    } else if (shape) commitFile(path, "rep.txt", REPEATED[shape].after, `feat: T1 ${shape}s X`);
    ledger(root, "T1", { state: "verified" });
    const ops = [];
    const walk = { pick, branch, fork, created };
    for (let n = 0, steps = 1 + Math.floor(pick() * 5); n < steps; n++)
      ops.push(step(root, { ...walk, step: n }));
    const on = onMain(root, walk);
    const why = `seed ${seed} (${shape ?? "plain"}): ${ops.join(" → ")}`;
    fixIn(root, ["--apply"]);
    if (isDone(root)) {
      assert.ok(on, `fix wrote done with the lines off main (${why})`);
      done.record++;
      continue;
    }
    fixIn(root, ["--apply", "--accept", "T1"]);
    assert.ok(!isDone(root) || on, `--accept wrote done with the lines off main (${why})`);
    if (isDone(root)) done.accept++;
    else if (on) done.refused++;
  }
  // The walks reach every outcome: proven by a record, accepted, and on main but not provable.
  assert.ok(done.record && done.accept && done.refused, JSON.stringify(done));
});
