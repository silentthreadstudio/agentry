// Tests for lib/process/drift.mjs: each nudge kind on a temp repo, the command it names, and the quiet
// cases (a ledgered worktree, no lifecycle, a board in a subfolder).
// Run: node --test plugin/scripts/test/drift.test.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { landing, mechanical, nudges } from "../lib/process/drift.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";
import {
  SPEC,
  boardRepo,
  builtBranch,
  handBranch,
  ledger,
  pickOntoMain,
  read,
} from "./drift-repo.mjs";
import { commitFile, git } from "./git-repo.mjs";

const cleanups = [];
after(() => {
  for (const c of cleanups) c();
});
function fresh(opts) {
  const repo = boardRepo(opts);
  cleanups.push(repo.cleanup);
  return repo;
}
function nudgesOf(root, spec) {
  const loaded = spec ?? loadSpec(join(root, ".agentry", "process.json"), { root }).spec;
  return nudges({ root, spec: loaded, model: readProcess({ root, spec: loaded }) });
}
const kinds = (list) => list.map((n) => n.kind).sort();

test("an agent worktree no ledger knows is unlisted-worktree and names /agentry:exec", () => {
  const { root } = fresh();
  handBranch(root, ".claude/worktrees/agent-a1", "worktree-agent-a1");
  const found = nudgesOf(root).filter((n) => n.kind === "unlisted-worktree");
  assert.equal(found.length, 1);
  assert.equal(found[0].command, "/agentry:exec <id>");
  assert.equal(found[0].branch, "worktree-agent-a1");
});

test("a worktree whose branch names a board task carries that id in its command", () => {
  const { root } = fresh();
  builtBranch(root, "T2");
  const [n] = nudgesOf(root).filter((x) => x.kind === "unlisted-worktree");
  assert.equal(n.id, "T2");
  assert.equal(n.command, "/agentry:exec T2");
});

test("a worktree a ledger owns, and one that is not an agent's, give no nudge", () => {
  const { root } = fresh();
  builtBranch(root, "T2");
  ledger(root, "T2");
  handBranch(root, "elsewhere", "feature-x");
  assert.deepEqual(kinds(nudgesOf(root)), ["started-by-hand", "started-by-hand"]);
});

test("a task the board started with no ledger is started-by-hand, naming exec with its id", () => {
  const { root } = fresh();
  const found = nudgesOf(root).filter((n) => n.kind === "started-by-hand");
  assert.deepEqual(
    found.map((n) => [n.id, n.command]),
    [
      ["T1", "/agentry:exec T1"],
      ["T3", "/agentry:exec T3"],
    ],
  );
  ledger(root, "T1");
  assert.deepEqual(
    nudgesOf(root)
      .filter((n) => n.kind === "started-by-hand")
      .map((n) => n.id),
    ["T3"],
  );
});

test("without a lifecycle the board has no started words, so nothing is started-by-hand", () => {
  const { root } = fresh();
  const { lifecycle, ...bare } = SPEC;
  assert.ok(lifecycle);
  assert.deepEqual(kinds(nudgesOf(root, bare)), []);
});

test("commits cherry-picked onto main by hand: merged-by-hand, naming merge", () => {
  const { root } = fresh();
  const { sha } = handBranch(root, ".claude/worktrees/agent-b2", "agentry/T2");
  pickOntoMain(root, sha);
  const [n] = nudgesOf(root).filter((x) => x.kind === "merged-by-hand");
  assert.equal(n.id, "T2");
  assert.equal(n.command, "/agentry:merge T2");
  assert.ok(!nudgesOf(root).some((x) => x.kind === "unlisted-worktree"));
});

test("a ledgered branch on main with no merge record nudges fix until the board catches up", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  ledger(root, "T1");
  assert.ok(!nudgesOf(root).some((x) => x.kind === "merged-by-hand"), "not on main yet");
  pickOntoMain(root, sha);
  const [n] = nudgesOf(root).filter((x) => x.kind === "merged-by-hand");
  assert.deepEqual([n.id, n.command], ["T1", "/agentry:board --fix"]);
});

test("a verified ledger with no merge is verified-not-merged, naming merge", () => {
  const { root } = fresh();
  builtBranch(root, "T3");
  ledger(root, "T3", { state: "verified" });
  const [n] = nudgesOf(root).filter((x) => x.kind === "verified-not-merged");
  assert.deepEqual([n.id, n.command], ["T3", "/agentry:merge T3"]);
  ledger(root, "T3", { state: "verified", merge: { preHead: "x", landed: [], step: "land" } });
  assert.ok(!nudgesOf(root).some((x) => x.kind === "verified-not-merged"));
});

test("an episode payload with no stamp is episode-pending, naming close", () => {
  const { root } = fresh();
  ledger(root, "T1", { state: "merged", episode: { payload: { task: "T1" } } });
  const [n] = nudgesOf(root).filter((x) => x.kind === "episode-pending");
  assert.deepEqual([n.id, n.command], ["T1", "/agentry:close"]);
  ledger(root, "T1", { state: "merged", episode: { payload: {}, writtenId: "e1" } });
  assert.ok(!nudgesOf(root).some((x) => x.kind === "episode-pending"));
});

test("a board kept in a subfolder of a repo still sees the repo's worktrees", () => {
  const { root } = fresh();
  handBranch(root, ".claude/worktrees/agent-c3", "worktree-agent-c3");
  const sub = join(root, "plan");
  const { spec } = loadSpec(join(root, ".agentry", "process.json"), { root });
  const found = nudges({ root: sub, runRoot: root, spec, model: readProcess({ root, spec }) });
  assert.deepEqual(
    found.filter((n) => n.path).map((n) => [n.kind, n.branch]),
    [["unlisted-worktree", "worktree-agent-c3"]],
  );
});

// ---- landing: work counts as on main only while it is there now (A23) ----

const at = (root, branch) => landing(root, { branch, onto: "main" });

test("landing: a cherry-pick later reverted on main is not landed", () => {
  const { root } = fresh();
  const { branch, sha } = builtBranch(root, "T1");
  const picked = pickOntoMain(root, sha);
  assert.deepEqual(at(root, branch), { shas: [picked] });
  git(root, "revert", "--no-edit", picked);
  assert.equal(at(root, branch), null);
  git(root, "revert", "--no-edit", "HEAD"); // a revert of the revert puts it back
  assert.ok(at(root, branch)?.shas);
});

test("landing: a branch only partly picked onto main is not landed", () => {
  const { root } = fresh();
  const { path, branch, sha } = builtBranch(root, "T1");
  commitFile(path, "T1b.txt", "second\n", "feat: T1 second");
  pickOntoMain(root, sha);
  assert.equal(at(root, branch), null);
});

test("landing: a --no-ff merge and a fast-forward by hand land the branch's own commits", () => {
  const merged = fresh().root;
  const one = builtBranch(merged, "T1");
  commitFile(merged, "m.txt", "main moved\n", "chore: move");
  git(merged, "merge", "--no-ff", "--no-edit", one.branch);
  assert.deepEqual(at(merged, one.branch), { shas: [one.sha] });
  const forwarded = fresh().root;
  const two = builtBranch(forwarded, "T1");
  const second = commitFile(two.path, "T1b.txt", "second\n", "feat: T1 second");
  git(forwarded, "merge", "--ff-only", two.branch);
  assert.deepEqual(at(forwarded, two.branch), { shas: [two.sha, second] });
});

test("landing: a squash is on main with no commits to name, so it is unsure", () => {
  const { root } = fresh();
  const { path, branch } = builtBranch(root, "T1");
  commitFile(path, "T1b.txt", "second\n", "feat: T1 second");
  git(root, "merge", "--squash", branch);
  git(root, "commit", "-q", "-m", "squash T1");
  assert.match(at(root, branch)?.unsure ?? "", /squashed/);
});

test("landing: a branch with no commits of its own, or reset to main, has not landed anything", () => {
  const { root } = fresh();
  const fresh1 = handBranch(root, ".claude/worktrees/agent-n1", "worktree-agent-n1");
  git(fresh1.path, "reset", "-q", "--hard", "main");
  commitFile(root, "m.txt", "main moved\n", "chore: move");
  git(fresh1.path, "reset", "-q", "--hard", "main");
  assert.equal(at(root, fresh1.branch), null, "reset onto main");
  git(root, "branch", "never-used");
  assert.equal(at(root, "never-used"), null, "created at main, never committed to");
});

test("a hand worktree merged --no-ff or fast-forwarded is merged-by-hand, not unlisted", () => {
  const { root } = fresh();
  const a = handBranch(root, ".claude/worktrees/agent-T2", "worktree-agent-T2", "a.txt");
  commitFile(root, "m.txt", "main moved\n", "chore: move");
  git(root, "merge", "--no-ff", "--no-edit", a.branch);
  const b = handBranch(root, ".claude/worktrees/agent-x7", "worktree-agent-x7", "b.txt");
  git(root, "merge", "--ff-only", b.branch);
  assert.deepEqual(
    nudgesOf(root)
      .filter((n) => n.path)
      .map((n) => [n.kind, n.branch, n.command]),
    [
      ["merged-by-hand", "worktree-agent-T2", "/agentry:merge <id>"],
      ["merged-by-hand", "worktree-agent-x7", "/agentry:merge <id>"],
    ],
  );
});

test("verified-not-merged clears once the work is on main and the board has caught up", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T3");
  ledger(root, "T3", { state: "verified" });
  const picked = pickOntoMain(root, sha);
  assert.deepEqual(
    nudgesOf(root)
      .filter((n) => n.id === "T3")
      .map((n) => n.kind),
    ["merged-by-hand"],
    "one nudge for the task, naming fix",
  );
  const short = picked.slice(0, 7);
  const text = read(root, "plan/BOARD.md").replace(
    "| T3   | S1     | verify |         |        |",
    `| T3   | S1     | done   |         | ${short} |`,
  );
  writeFileSync(join(root, "plan", "BOARD.md"), text);
  writeFileSync(
    join(root, "plan", "sprints", "S1.md"),
    `# S1\n\n## Handoff\n\n- **T3** (${short}): x\n`,
  );
  assert.deepEqual(
    nudgesOf(root).filter((n) => n.id === "T3"),
    [],
  );
});

test("a task gets one nudge at most: a worktree named for it hides its started-by-hand", () => {
  const { root } = fresh();
  builtBranch(root, "T1");
  assert.deepEqual(
    nudgesOf(root)
      .filter((n) => n.id === "T1")
      .map((n) => n.kind),
    ["unlisted-worktree"],
  );
});

test("mechanical: a merge record whose commits were reverted on main is reported, not fixed", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  const main = pickOntoMain(root, sha);
  git(root, "revert", "--no-edit", main);
  ledger(root, "T1", { state: "merged", merge: { preHead: "x", landed: [main], step: "done" } });
  const spec = loadSpec(join(root, ".agentry", "process.json"), { root }).spec;
  const plan = mechanical({ root, spec, model: readProcess({ root, spec }) });
  assert.deepEqual(plan.fixes, []);
  assert.match(plan.left.join("\n"), /T1: merged, but those commits are undone on main/);
});

test("mechanical: a ledger with a merge record gives one fix naming what the board lacks", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  const main = pickOntoMain(root, sha);
  ledger(root, "T1", { state: "merged", merge: { preHead: "x", landed: [main], step: "done" } });
  const spec = loadSpec(join(root, ".agentry", "process.json"), { root }).spec;
  const plan = mechanical({ root, spec, model: readProcess({ root, spec }) });
  assert.deepEqual(
    plan.fixes.map((f) => [f.id, f.need, f.shas]),
    [["T1", ["status", "commit", "handoff"], [main]]],
  );
  assert.deepEqual(plan.left, []);
});
