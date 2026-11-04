// Tests for lib/process/drift.mjs: each nudge kind on a temp repo, the command it names, and the quiet
// cases (a ledgered worktree, no lifecycle, a board in a subfolder).
// Run: node --test plugin/scripts/test/drift.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileSpike } from "../lib/lane/spikes.mjs";
import { keptTrees, landing, mechanical, nudges } from "../lib/process/drift.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";
import {
  SPEC,
  boardRepo,
  builtBranch,
  handBranch,
  ledger,
  mergeOntoMain,
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

test("an agent worktree no ledger knows is unlisted-worktree: land, continue, file or remove it, never /agentry:exec", () => {
  const { root } = fresh();
  handBranch(root, ".claude/worktrees/agent-a1", "worktree-agent-a1");
  const found = nudgesOf(root).filter((n) => n.kind === "unlisted-worktree");
  assert.equal(found.length, 1);
  assert.equal(
    found[0].command,
    'land: lane merge <id> --branch worktree-agent-a1 · continue: lane exec adopt <id> --branch worktree-agent-a1 · file: lane spike worktree-agent-a1 --for <id>|--keep "<why>" · remove: git worktree remove .claude/worktrees/agent-a1',
  );
  assert.equal(found[0].branch, "worktree-agent-a1");
  assert.ok(!nudgesOf(root).some((n) => n.path && n.command.includes("/agentry:exec")));
});

test("a worktree whose branch names a board task carries that id in its command", () => {
  const { root } = fresh();
  handBranch(root, ".claude/worktrees/fix-t2", "fix/T2");
  const [n] = nudgesOf(root).filter((x) => x.kind === "unlisted-worktree");
  assert.equal(n.id, "T2");
  assert.equal(
    n.command,
    'land: lane merge T2 --branch fix/T2 · continue: lane exec adopt T2 --branch fix/T2 · file: lane spike fix/T2 --for T2|--keep "<why>" · remove: git worktree remove .claude/worktrees/fix-t2',
  );
});

test("an orphan agentry/<id> worktree (no ledger) is offered only the ways on that work: land, file, remove", () => {
  const { root } = fresh();
  builtBranch(root, "T2");
  const [n] = nudgesOf(root).filter((x) => x.kind === "unlisted-worktree");
  assert.equal(n.id, "T2");
  assert.equal(
    n.command,
    'land: lane merge T2 --branch agentry/T2 · file: lane spike agentry/T2 --for T2|--keep "<why>" · remove: git worktree remove .agentry/run/worktrees/T2',
  );
  // Filed for its own id, its spike-for row lands it, never adopts it onto its own branch name.
  fileSpike(root, {
    branch: "agentry/T2",
    path: join(root, ".agentry", "run", "worktrees", "T2"),
    for: "T2",
    at: "2026-01-01T00:00:00Z",
  });
  const [row] = nudgesOf(root).filter((x) => x.kind === "spike-for");
  assert.equal(row.command, "land: lane merge T2 --branch agentry/T2");
});

test("a branch or path that needs it is shell-quoted in the row; the placeholders are not", () => {
  const { root } = fresh();
  handBranch(root, ".claude/worktrees/my tree", "feat;touch-x");
  const [n] = nudgesOf(root).filter((x) => x.kind === "unlisted-worktree");
  assert.equal(
    n.command,
    `land: lane merge <id> --branch 'feat;touch-x' · continue: lane exec adopt <id> --branch 'feat;touch-x' · file: lane spike 'feat;touch-x' --for <id>|--keep "<why>" · remove: git worktree remove '.claude/worktrees/my tree'`,
  );
});

test("an unreadable spikes.json is one nudge naming the file, not read as empty", () => {
  const { root } = fresh();
  handBranch(root, ".claude/worktrees/agent-k1", "worktree-agent-k1");
  mkdirSync(join(root, ".agentry", "run"), { recursive: true });
  writeFileSync(join(root, ".agentry", "run", "spikes.json"), '[{"branch": "x"');
  const rows = nudgesOf(root).filter((x) => x.kind === "spikes-unreadable");
  assert.deepEqual(
    rows.map((x) => [x.path, x.command]),
    [[".agentry/run/spikes.json", "lane spike says why · fix or remove .agentry/run/spikes.json"]],
  );
});

test("a branch a lane adopted (exec adopt) is no longer unlisted-worktree", () => {
  const { root } = fresh();
  const tree = handBranch(root, ".claude/worktrees/agent-d4", "worktree-agent-d4");
  assert.ok(nudgesOf(root).some((n) => n.kind === "unlisted-worktree"));
  ledger(root, "T2", {
    adopted: { branch: tree.branch, tip: tree.sha, commits: [], worktree: tree.path },
  });
  assert.ok(!nudgesOf(root).some((n) => n.kind === "unlisted-worktree"));
});

// ---- spikes: worktrees `lane spike` filed (field 87) ----

const spiked = (root, tree, extra) =>
  fileSpike(root, { branch: tree.branch, path: tree.path, ...extra, at: "2026-01-01T00:00:00Z" });
const keptOf = (root) => {
  const { spec } = loadSpec(join(root, ".agentry", "process.json"), { root });
  return keptTrees({ root, spec }).map((t) => t.branch);
};

test("a spike filed --keep is shown with the kept worktrees, never as drift", () => {
  const { root } = fresh();
  const tree = handBranch(root, ".claude/worktrees/agent-k1", "worktree-agent-k1");
  spiked(root, tree, { keep: "the benchmark rig" });
  assert.ok(!nudgesOf(root).some((n) => n.branch === tree.branch));
  assert.deepEqual(keptOf(root), [tree.branch]);
});

test("a spike filed --for shows one spike-for row until a ledger for the item adopts or merges its branch", () => {
  for (const took of ["adopted", "merged"]) {
    const { root } = fresh();
    const tree = handBranch(root, ".claude/worktrees/agent-f1", "worktree-agent-f1");
    spiked(root, tree, { for: "T2" });
    const rows = nudgesOf(root).filter((n) => n.branch === tree.branch);
    assert.deepEqual(
      rows.map((n) => [n.kind, n.id, n.command]),
      [
        [
          "spike-for",
          "T2",
          "land: lane merge T2 --branch worktree-agent-f1 · continue: lane exec adopt T2 --branch worktree-agent-f1",
        ],
      ],
    );
    assert.deepEqual(keptOf(root), []);
    // Another item's ledger on that branch does not take it.
    ledger(root, "T1", {
      adopted: { branch: tree.branch, tip: tree.sha, commits: [], worktree: null },
    });
    assert.ok(nudgesOf(root).some((n) => n.kind === "spike-for"));
    if (took === "adopted")
      ledger(root, "T2", {
        adopted: { branch: tree.branch, tip: tree.sha, commits: [], worktree: tree.path },
      });
    else ledger(root, "T2", { branch: tree.branch, origin: "adopted", state: "merging" });
    assert.ok(!nudgesOf(root).some((n) => n.branch === tree.branch), took);
  }
});

test("a spike whose branch is gone is dropped from the view: no row, not kept", () => {
  const { root } = fresh();
  const a = handBranch(root, ".claude/worktrees/agent-g1", "worktree-agent-g1");
  const b = handBranch(root, ".claude/worktrees/agent-g2", "worktree-agent-g2");
  spiked(root, a, { for: "T2" });
  spiked(root, b, { keep: "kept" });
  for (const t of [a, b]) {
    git(root, "worktree", "remove", "--force", t.path);
    git(root, "branch", "-D", t.branch);
  }
  assert.ok(!nudgesOf(root).some((n) => n.kind === "spike-for" || n.path));
  assert.deepEqual(keptOf(root), []);
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
  assert.equal(
    n.command,
    "/agentry:merge T2 --branch agentry/T2, then /agentry:board fix --accept T2",
  );
  assert.ok(!nudgesOf(root).some((x) => x.kind === "unlisted-worktree"));
});

test("a ledgered branch on main with no merge record nudges fix --accept, and fix alone writes nothing", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  ledger(root, "T1");
  assert.ok(!nudgesOf(root).some((x) => x.kind === "merged-by-hand"), "not on main yet");
  pickOntoMain(root, sha);
  const [n] = nudgesOf(root).filter((x) => x.kind === "merged-by-hand");
  assert.deepEqual([n.id, n.command], ["T1", "/agentry:board fix --accept T1"]);
  const spec = loadSpec(join(root, ".agentry", "process.json"), { root }).spec;
  assert.deepEqual(mechanical({ root, spec, model: readProcess({ root, spec }) }).fixes, []);
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

test("a branch with no history in common with main is not landed, and does not hide one that is", () => {
  const { root } = fresh();
  const lonely = join(root, "lonely");
  git(root, "worktree", "add", "-q", "--detach", lonely, "main");
  git(lonely, "checkout", "-q", "--orphan", "agentry/T2");
  git(lonely, "rm", "-rqf", ".");
  commitFile(lonely, "other.txt", "unrelated\n", "feat: an unrelated history");
  ledger(root, "T2");
  const { sha } = builtBranch(root, "T1");
  ledger(root, "T1");
  pickOntoMain(root, sha);
  assert.equal(at(root, "agentry/T2"), null);
  const byHand = nudgesOf(root).filter((n) => n.kind === "merged-by-hand");
  assert.deepEqual(
    byHand.map((n) => n.id),
    ["T1"],
  );
});

// The git processes `run` starts (GIT_TRACE2 counts every one, nested ones included).
function gitCalls(run) {
  const dir = mkdtempSync(join(tmpdir(), "agentry-trace-"));
  process.env.GIT_TRACE2_EVENT = join(dir, "trace.json");
  try {
    run();
    const trace = readFileSync(join(dir, "trace.json"), "utf8");
    return trace.split("\n").filter((l) => l.includes('"event":"start"')).length;
  } finally {
    Reflect.deleteProperty(process.env, "GIT_TRACE2_EVENT");
    rmSync(dir, { recursive: true, force: true });
  }
}

test("nudges ask git once per run, not per ledger: ten more branches, picked or not, cost no more", () => {
  const { root } = fresh();
  const add = (from, n) => {
    for (let i = from; i < from + n; i++) {
      const { sha } = builtBranch(root, `T${i}`);
      ledger(root, `T${i}`);
      if (i % 2) pickOntoMain(root, sha);
    }
  };
  add(10, 2);
  const before = gitCalls(() => nudgesOf(root));
  add(20, 10);
  const after = gitCalls(() => nudgesOf(root));
  assert.ok(after <= before, `${before} git calls for 2 ledgers, ${after} for 12`);
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
    ["worktree-agent-T2", "worktree-agent-x7"].map((branch) => [
      "merged-by-hand",
      branch,
      `/agentry:merge <id> --branch ${branch}, then /agentry:board fix --accept <id>`,
    ]),
  );
});

test("a verified lane parked for later is no verified-not-merged (field 63)", () => {
  const { root } = fresh();
  builtBranch(root, "T3");
  ledger(root, "T3", {
    state: "held",
    next: "resume",
    hold: { for: "later", when: "verified", next: "merge", since: "2026-11-03T09:05:00.000Z" },
  });
  assert.ok(!nudgesOf(root).some((x) => x.kind === "verified-not-merged"));
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
  const [main] = mergeOntoMain(root, "T1", [sha]);
  git(root, "revert", "--no-edit", main);
  const spec = loadSpec(join(root, ".agentry", "process.json"), { root }).spec;
  const plan = mechanical({ root, spec, model: readProcess({ root, spec }) });
  assert.deepEqual(plan.fixes, []);
  assert.match(plan.left.join("\n"), /T1: merged, but the line it added at T1\.txt:1 is not there/);
});

test("mechanical: a ledger with a merge record gives one fix naming what the board lacks", () => {
  const { root } = fresh();
  const { sha } = builtBranch(root, "T1");
  const [main] = mergeOntoMain(root, "T1", [sha]);
  const spec = loadSpec(join(root, ".agentry", "process.json"), { root }).spec;
  const plan = mechanical({ root, spec, model: readProcess({ root, spec }) });
  assert.deepEqual(
    plan.fixes.map((f) => [f.id, f.need, f.shas]),
    [["T1", ["status", "commit", "handoff"], [main]]],
  );
  assert.deepEqual(plan.left, []);
});

// SPEC with a debt kind beside the task kind, run by exec; its row is on the board, doing.
const DEBT_SPEC = {
  ...SPEC,
  kinds: {
    ...SPEC.kinds,
    debt: {
      label: "Debt",
      at: { table: "BOARD.md", heading: "Debt" },
      id: { column: "Debt" },
      fields: {
        status: { column: "Status" },
        verdict: { column: "Verdict" },
        commit: { column: "Commit", type: "commits" },
      },
      status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
    },
  },
  exec: {
    kinds: {
      debt: {
        on: { dispatched: "doing", built: "doing", failed: "doing", merged: "done" },
        write: { status: "status", verdict: "verdict", commit: "commit" },
      },
    },
  },
};
function debtRepo() {
  const repo = fresh({ spec: DEBT_SPEC });
  const board = join(repo.root, "plan", "BOARD.md");
  writeFileSync(
    board,
    `${readFileSync(board, "utf8")}\n## Debt\n\n| Debt | Status | Verdict | Commit |\n| ---- | ------ | ------- | ------ |\n| D-1  | doing  |         |        |\n`,
  );
  git(repo.root, "commit", "-q", "-am", "debt row");
  return repo;
}

test("mechanical: a landed debt row lacking its cells is reported as left, never planned", () => {
  const { root } = debtRepo();
  const { sha } = builtBranch(root, "D-1");
  mergeOntoMain(root, "D-1", [sha]);
  const file = join(root, ".agentry", "run", "process", "ledger", "D-1.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), kind: "debt" }));
  const spec = loadSpec(join(root, ".agentry", "process.json"), { root }).spec;
  const plan = mechanical({ root, spec, model: readProcess({ root, spec }) });
  assert.deepEqual(plan.fixes, []);
  assert.deepEqual(plan.left, [
    "D-1 lacks its status cell; board fix writes the task kind only → agentry board set debt D-1 status=… --apply",
    "D-1 lacks its commit cell; board fix writes the task kind only → agentry board set debt D-1 commit=… --apply",
  ]);
});
