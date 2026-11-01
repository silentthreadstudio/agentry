// Tests for `lane exec` (lib/lane/cli/exec.mjs) on temp git repos: start cuts the worktree and briefs the
// builder; report / verdict / gate / close step the ledger; the board moves only through the lifecycle
// (dispatched → built → (failed) → verdict) and not at all without one; maxWriters refuses; the main-touched
// and moved-tip guards fire. A builder or verifier is simulated by committing in the worktree and writing
// its report file.
// Run: node --test plugin/scripts/test/exec-cli.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitFile, git, gitEnv } from "./git-repo.mjs";

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
  name: "Exec",
  root: "plan",
  kinds: {
    sprint: {
      label: "Sprint",
      at: { table: "BOARD.md", heading: "Sprints" },
      id: { column: "Sprint" },
      fields: { status: { column: "Status" } },
      status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
    },
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: {
        sprint: { column: "Sprint", type: "ref", ref: "sprint", role: "parent" },
        status: { column: "Status" },
        verdict: { column: "Verdict" },
        commit: { column: "Commit", type: "commits" },
      },
      status: {
        field: "status",
        values: { todo: "planned", doing: "active", verify: "active", done: "done" },
      },
      contract: { blocks: ["TASKS.md"] },
    },
    decision: {
      label: "Decision",
      at: { table: "DECISIONS.md", heading: "Decisions" },
      id: { column: "#", prefix: "D" },
      fields: { decision: { column: "Decision" } },
    },
  },
  rules: [{ rule: "ids-unique" }, { rule: "status-known" }],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", built: "verify", failed: "doing", merged: "done" },
    write: { status: "status", verdict: "verdict", commit: "commit" },
  },
  gate: { command: ["sh", "-c", "test -f out.txt"] },
};
const BOARD_MD = `# Exec

## Sprints

| Sprint | Status |
| ------ | ------ |
| S1     | doing  |

## Tasks

| Task | Sprint | Status | Verdict | Commit |
| ---- | ------ | ------ | ------- | ------ |
| T1   | S1     | todo   |         |        |
| T2   | S1     | todo   |         |        |
`;
const TASKS_MD = `# Tasks

- **T1** (S1): owns \`out.txt\`, \`src/ui/panel.css\`; follows D1. Accept: out.txt exists.
- **T2** (S1): owns \`two.txt\`. Accept: two.txt exists.
`;
const DECISIONS_MD = `# Decisions

## Decisions

| # | Decision |
| - | -------- |
| 1 | Plain files |
| 2 | Not cited |
`;

/** A repo on `main` with the board committed; `home` is an empty HOME for the CLI (no global config or
 *  memory leaks in). */
function repo({ spec = SPEC, config } = {}) {
  const root = temp("exec-repo-");
  const home = temp("exec-home-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agentry"));
  writeFileSync(join(root, ".agentry", "process.json"), JSON.stringify(spec, null, 2));
  if (config) writeFileSync(join(root, ".agentry", "config.json"), JSON.stringify(config));
  commitFile(root, ".gitignore", ".agentry/run/\n.agentry/config.json\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  commitFile(root, "plan/DECISIONS.md", DECISIONS_MD);
  commitFile(root, ".agentry/process.json", JSON.stringify(spec, null, 2));
  return { root, home };
}
function lane({ root, home }, ...args) {
  const res = spawnSync("node", [LANE, "exec", ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home },
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* not JSON: a refusal on stderr */
  }
  return { exit: res.status, json, stderr: res.stderr };
}
const board = (root) => readFileSync(join(root, "plan", "BOARD.md"), "utf8");
const row = (root, id) =>
  board(root)
    .split("\n")
    .find((l) => l.startsWith(`| ${id} `))
    .split("|")
    .map((c) => c.trim())
    .slice(1, -1);
const ledgerOf = (root, id) =>
  JSON.parse(
    readFileSync(join(root, ".agentry", "run", "process", "ledger", `${id}.json`), "utf8"),
  );
// The lines of `after` that differ from `before`, as text.
const changedLines = (before, after) => {
  const a = before.split("\n");
  return after.split("\n").filter((line, i) => line !== a[i]);
};

// A builder's work: commit a file in the worktree, write the report.
function build(out, file = "out.txt", status = "DONE") {
  commitFile(out.worktree, file, "made\n", `feat: add ${file}`);
  writeFileSync(out.reportPath, `${status}\nadded ${file}\nused_memories: none\n`);
}
const judge = (out, verdict) =>
  writeFileSync(
    out.reportPath,
    `All acceptance items checked.\nused_memories: none\nVerdict: ${verdict}\n`,
  );

test("start cuts agentry/<id> in a worktree, writes `dispatched` and prints the two-line prompt", () => {
  const r = repo();
  const before = board(r.root);
  const { exit, json } = lane(r, "start", "T1");
  assert.equal(exit, 0);
  assert.equal(json.step, "start");
  assert.equal(json.next, "build");
  assert.equal(json.branch, "agentry/T1");
  assert.equal(json.worktree, join(r.root, ".agentry", "run", "worktrees", "T1"));
  assert.ok(existsSync(join(json.worktree, "plan", "BOARD.md")));
  const [marker, read] = json.prompt.split("\n");
  assert.equal(marker, "agentry-task: T1 role=build round=1");
  assert.equal(
    read,
    `Read your brief first: ${json.brief}. Work only in ${json.worktree}; prefix every shell command with \`cd ${json.worktree} &&\`.`,
  );
  assert.equal(json.mode, "fresh");
  assert.deepEqual(json.dispatch, { agent: "designer", why: "src/ui/panel.css is UI-shaped" });
  assert.match(json.after, /exec report T1 --root .* --agent <the agent's id>$/);
  assert.deepEqual(changedLines(before, board(r.root)), [
    "| T1   | S1     | doing  |         |        |",
  ]);
  assert.deepEqual(json.board.writes, [{ file: "plan/BOARD.md", what: "status → doing" }]);
  const brief = readFileSync(json.brief, "utf8");
  assert.match(brief, /- \*\*T1\*\* \(S1\): owns `out\.txt`, `src\/ui\/panel\.css`; follows D1\./);
  assert.match(brief, /- `out\.txt`\n- `src\/ui\/panel\.css`/);
  assert.match(brief, /- D1: \| 1 \| Plain files \|/);
  assert.doesNotMatch(brief, /Not cited/);
  assert.match(brief, /none \(memory\.prime is "conductor"/);
  assert.match(
    brief,
    new RegExp(`Write your full report to ${json.reportPath.replace(/[.]/g, "\\.")}`),
  );
  const ledger = ledgerOf(r.root, "T1");
  assert.deepEqual([ledger.state, ledger.origin, ledger.mainBranch], ["building", "exec", "main"]);
  assert.equal(ledger.base, git(r.root, "rev-parse", "HEAD"));
  assert.deepEqual(ledger.contract, { file: "plan/TASKS.md", line: 3 });
});

test("the brief carries recalled facts when memory.prime is all, none at off", () => {
  for (const prime of ["all", "off"]) {
    const r = repo({ config: { memory: { prime } } });
    const facts = join(r.root, ".agentry", "memory", "facts");
    mkdirSync(facts, { recursive: true });
    writeFileSync(
      join(facts, "g.md"),
      "---\nid: g:01PANEL\ntype: gotcha\nconfidence: 0.9\nprovenance:\n  - src/ui/panel.css\n---\nThe panel stylesheet must keep its focus ring.\n",
    );
    const { exit, json } = lane(r, "start", "T1");
    assert.equal(exit, 0);
    const brief = readFileSync(json.brief, "utf8");
    if (prime === "all") assert.match(brief, /\[gotcha · g:01PANEL\] The panel stylesheet/);
    else {
      assert.doesNotMatch(brief, /g:01PANEL/);
      assert.match(brief, /none \(memory\.prime is "off"/);
    }
  }
});

test("start refuses at lanes.maxWriters and names the open ledgers and unowned worktrees", () => {
  const r = repo({ config: { lanes: { maxWriters: 2 } } });
  assert.equal(lane(r, "start", "T1").exit, 0);
  git(
    r.root,
    "worktree",
    "add",
    "-q",
    "-b",
    "by-hand",
    join(r.root, "..", `${r.root.split("/").at(-1)}-hand`),
  );
  temps.push(join(r.root, "..", `${r.root.split("/").at(-1)}-hand`));
  const before = board(r.root);
  const refused = lane(r, "start", "T2");
  assert.equal(refused.exit, 2);
  assert.match(refused.stderr, /2 writer\(s\) open, lanes\.maxWriters is 2/);
  assert.match(refused.stderr, /T1 \(building, ledger .*worktrees\/T1\)/);
  assert.match(refused.stderr, /-hand \(by-hand, no ledger\)/);
  assert.equal(board(r.root), before, "a refusal writes nothing");
  assert.equal(existsSync(join(r.root, ".agentry", "run", "worktrees", "T2")), false);
});

test("start refuses a second lane for the same id, an unknown contract and a broken config", () => {
  const r = repo();
  assert.equal(lane(r, "start", "T1").exit, 0);
  assert.match(
    lane(r, "start", "T1").stderr,
    /a lane for T1 exists \(state building, next build\)/,
  );
  assert.match(lane(r, "start", "T9").stderr, /contract T9: not-found/);
  const bad = repo({ config: { lanes: { maxWriters: 0 } } });
  const res = lane(bad, "start", "T1");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /lanes\.maxWriters should be a whole number above 0/);
});

test("a full lane: build → verify PASS → gate → close; the board moves only as the lifecycle says", () => {
  const r = repo();
  const before = board(r.root);
  let out = lane(r, "start", "T1").json;

  const missing = lane(r, "report", "T1");
  assert.equal(missing.exit, 2);
  assert.match(
    missing.stderr,
    /no report at .*r1-build\.report\.md: save the builder's full reply there/,
  );

  build(out);
  const reported = lane(r, "report", "T1", "--agent", "builder-1");
  assert.equal(reported.exit, 0);
  out = reported.json;
  assert.equal(out.next, "verify");
  assert.equal(out.role, "verify");
  assert.deepEqual(out.dispatch, { agent: "verifier" });
  assert.equal(out.prompt.split("\n")[0], "agentry-task: T1 role=verify round=2");
  assert.deepEqual(row(r.root, "T1"), ["T1", "S1", "verify", "", ""]);
  const verifyBrief = readFileSync(out.brief, "utf8");
  assert.match(verifyBrief, /exec gate T1 --root/);

  judge(out, "PASS");
  const judged = lane(r, "verdict", "T1", "--agent", "verifier-1");
  assert.equal(judged.exit, 0);
  assert.equal(judged.json.verdict, "PASS");
  assert.equal(judged.json.next, "gate");
  assert.match(judged.json.run, /exec gate T1 --root/);
  assert.deepEqual(row(r.root, "T1"), ["T1", "S1", "verify", "PASS", ""]);

  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 0);
  assert.equal(gated.json.next, "close");
  assert.equal(gated.json.gate.exit, 0);
  assert.equal(gated.json.gate.tier, "full");
  assert.ok(gated.json.gate.log.endsWith("logs/gate-1.log"));

  const closed = lane(r, "close", "T1");
  assert.equal(closed.exit, 0);
  assert.equal(closed.json.next, "merge");
  assert.equal(closed.json.run, "/agentry:merge T1");
  const episode = closed.json.episode;
  assert.equal(episode.shape, "exec");
  assert.equal(episode.task, "T1: added out.txt");
  assert.equal(episode.retries, 0);
  assert.match(episode.outcome, /^verified \(PASS\); rounds: build, verify; verdicts: PASS;/);
  assert.match(episode.outcome, /worktree gate: green full on [0-9a-f]{7}/);
  const stamped = lane(r, "close", "T1", "--episode", "e-42");
  assert.equal(stamped.exit, 0);
  const ledger = ledgerOf(r.root, "T1");
  assert.equal(ledger.episode.writtenId, "e-42");
  assert.equal(ledger.state, "verified");
  assert.equal(ledger.gates.length, 1);
  assert.equal(ledger.rounds.filter((x) => x.verdict).length, 1);

  // the board: only T1's status and verdict cells changed, nothing else
  assert.deepEqual(changedLines(before, board(r.root)), [
    "| T1   | S1     | verify | PASS    |        |",
  ]);
  assert.equal(git(r.root, "status", "--porcelain"), "M plan/BOARD.md");
});

test("a FAIL writes the verdict and the failed status, then a fix round resumes the builder", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1", "--agent", "builder-1").json;
  judge(out, "FAIL");
  const failed = lane(r, "verdict", "T1", "--agent", "verifier-1");
  assert.equal(failed.exit, 0);
  out = failed.json;
  assert.equal(out.next, "fix");
  assert.deepEqual([out.role, out.mode, out.agent], ["build", "resume", "builder-1"]);
  assert.deepEqual(row(r.root, "T1"), ["T1", "S1", "doing", "FAIL", ""]);
  const brief = readFileSync(out.brief, "utf8");
  assert.match(brief, /^# Fix T1, round 3/);
  assert.match(brief, /The verifier's FAIL is in .*r2-verify\.report\.md/);

  build(out, "fix.txt");
  out = lane(r, "report", "T1").json;
  assert.equal(out.next, "recheck");
  assert.deepEqual([out.mode, out.agent], ["resume", "verifier-1"]);
  assert.deepEqual(row(r.root, "T1"), ["T1", "S1", "verify", "FAIL", ""]);
  assert.match(readFileSync(out.brief, "utf8"), /## Recheck/);
});

test("without a lifecycle the lane writes nothing to the board, and says every step was skipped", () => {
  const { lifecycle, ...spec } = SPEC;
  assert.ok(lifecycle);
  const r = repo({ spec });
  const before = board(r.root);
  let out = lane(r, "start", "T1").json;
  assert.deepEqual(out.board, { writes: [], skipped: [{ what: "status", why: "lifecycle off" }] });
  build(out);
  out = lane(r, "report", "T1").json;
  judge(out, "FAIL");
  out = lane(r, "verdict", "T1").json;
  assert.deepEqual(out.board.writes, []);
  assert.equal(board(r.root), before);
  assert.equal(git(r.root, "status", "--porcelain"), "");
});

test("a builder that changes the main checkout stops the lane (exit 1) and names the guard", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out);
  writeFileSync(join(r.root, "stray.txt"), "oops\n");
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 1);
  assert.equal(res.json.next, "stop");
  assert.match(res.json.reason, /main touched: files changed: \?\? stray\.txt/);
  assert.deepEqual(res.json.guards, [res.json.reason]);
  assert.deepEqual(row(r.root, "T1"), ["T1", "S1", "doing", "", ""], "no `built` on a stop");
  assert.equal(lane(r, "show", "T1").exit, 1);
});

test("a commit on main stops the lane; one another lane's merge recorded does not", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out);
  const sha = commitFile(r.root, "plan/NOTES.md", "x\n", "docs: note");
  const ledgerDir = join(r.root, ".agentry", "run", "process", "ledger");
  writeFileSync(
    join(ledgerDir, "T2.json"),
    JSON.stringify({
      v: 1,
      id: "T2",
      state: "merged",
      worktree: "/gone",
      merge: { landed: [sha] },
    }),
  );
  assert.equal(lane(r, "report", "T1").json.next, "verify");

  const r2 = repo();
  const out2 = lane(r2, "start", "T1").json;
  build(out2);
  commitFile(r2.root, "plan/NOTES.md", "x\n", "docs: by hand");
  const res = lane(r2, "report", "T1");
  assert.equal(res.exit, 1);
  assert.match(res.json.reason, /main touched: HEAD moved/);
});

test("uncommitted files in the worktree send the builder back with the reason", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out);
  writeFileSync(join(out.worktree, "left.txt"), "x\n");
  const res = lane(r, "report", "T1", "--agent", "b1");
  assert.equal(res.exit, 0);
  assert.equal(res.json.next, "fix");
  assert.match(res.json.why, /uncommitted files in the worktree: \?\? left\.txt/);
  assert.match(readFileSync(res.json.brief, "utf8"), /The lane refused your last report/);
});

test("a verdict given after the branch tip moved is void: recheck, and no verdict is written", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1", "--agent", "b1").json;
  commitFile(out.worktree, "late.txt", "x\n", "feat: late");
  judge(out, "PASS");
  const res = lane(r, "verdict", "T1", "--agent", "v1");
  assert.equal(res.exit, 0);
  assert.equal(res.json.verdict, "void");
  assert.equal(res.json.next, "recheck");
  assert.match(res.json.why, /tip moved/);
  assert.deepEqual(row(r.root, "T1"), ["T1", "S1", "verify", "", ""]);
});

test("a red gate exits 1; run at the gate step it stops the lane", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out, "other.txt");
  out = lane(r, "report", "T1").json;
  const midVerify = lane(r, "gate", "T1");
  assert.equal(midVerify.exit, 1, "the verifier reads a red gate from the exit code");
  assert.equal(midVerify.json.next, "verify", "mid-verify the gate only records");
  judge(out, "PASS");
  assert.equal(lane(r, "verdict", "T1").json.next, "gate");
  const res = lane(r, "gate", "T1");
  assert.equal(res.exit, 1);
  assert.equal(res.json.next, "stop");
  assert.match(res.json.reason, /worktree gate is red \(exit 1\)/);
  const closed = lane(r, "close", "T1");
  assert.equal(closed.exit, 0);
  assert.match(closed.json.episode.outcome, /^stopped: the worktree gate is red/);
});

test("steps out of order, a dirty worktree at the gate and a worktree root are refused (exit 2)", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  const early = lane(r, "verdict", "T1");
  assert.equal(early.exit, 2);
  assert.match(early.stderr, /expects report now, not a verdict/);
  assert.match(lane(r, "close", "T1").stderr, /not done \(state building, next build\)/);
  writeFileSync(join(out.worktree, "dirty.txt"), "x\n");
  assert.match(lane(r, "gate", "T1").stderr, /not clean, so the gate did not run: \?\? dirty\.txt/);
  const inside = spawnSync("node", [LANE, "exec", "show", "T1", "--root", out.worktree], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home },
  });
  assert.equal(inside.status, 2);
  assert.match(inside.stderr, /runs from the main checkout: pass --root /);
  assert.match(lane(r, "report", "T1", "--episode", "x").stderr, /report takes no --episode/);
  assert.match(lane(r, "show", "a..b").stderr, /must not contain "\.\."/);
  assert.match(lane(r, "show", "T2").stderr, /no lane for T2/);
});

test("show prints the pending dispatch for a cold resume", () => {
  const r = repo();
  const started = lane(r, "start", "T1").json;
  const shown = lane(r, "show", "T1");
  assert.equal(shown.exit, 0);
  assert.equal(shown.json.prompt, started.prompt);
  assert.deepEqual(shown.json.rounds, [{ n: 1, step: "build", mode: "fresh" }]);
  assert.deepEqual(shown.json.nested, []);
});

test("a worktree that appears during the lane and belongs to no lane is reported as nested", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out);
  const nested = join(r.root, ".agentry", "run", "nested-x");
  git(r.root, "worktree", "add", "-q", "-b", "nested-x", nested);
  const res = lane(r, "report", "T1");
  assert.deepEqual(res.json.nested, [nested]);
  assert.deepEqual(ledgerOf(r.root, "T1").nested, [nested]);
});
