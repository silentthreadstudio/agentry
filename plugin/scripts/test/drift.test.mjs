// Tests for lib/process/drift.mjs: each nudge kind on a temp repo, the command it names, and the quiet
// cases (a ledgered worktree, no lifecycle, a board in a subfolder).
// Run: node --test plugin/scripts/test/drift.test.mjs
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { mechanical, nudges } from "../lib/process/drift.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";
import { SPEC, boardRepo, builtBranch, handBranch, ledger, pickOntoMain } from "./drift-repo.mjs";

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
