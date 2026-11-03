// Tests for `lane exec` (lib/lane/cli/exec.mjs) on temp git repos: start cuts the worktree and briefs the
// builder; report / verdict / gate / close step the ledger; the board moves only through the lifecycle
// (dispatched → built → (failed) → verdict) and not at all without one; maxWriters refuses; the main-touched
// and moved-tip guards fire. A builder or verifier is simulated by committing in the worktree and writing
// its report file.
// Run: node --test plugin/scripts/test/exec-cli.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
function repo({ spec = SPEC, config, prefix = "exec-repo-" } = {}) {
  const root = temp(prefix);
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
    `Read your brief first: ${json.brief}. Work only in ${json.worktree}; prefix every shell command with \`cd '${json.worktree}' &&\`.`,
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

test("a later note on the task rides in the build and verify briefs, with its file:line", () => {
  const r = repo();
  const note = "- **T2** deps T1 (accept as: two.txt holds the word two)";
  commitFile(r.root, "plan/TASKS.md", `${TASKS_MD}${note}\n`);
  const { exit, json } = lane(r, "start", "T2");
  assert.equal(exit, 0);
  const section = `## Later notes on this task\n\nThey override the contract where they conflict.\n\n- plan/TASKS.md:5: ${note}\n`;
  assert.ok(readFileSync(json.brief, "utf8").includes(section));
  assert.deepEqual(ledgerOf(r.root, "T2").contract.related, [
    { at: "plan/TASKS.md:5", text: note },
  ]);
  const one = lane(r, "start", "T1");
  assert.doesNotMatch(readFileSync(one.json.brief, "utf8"), /Later notes/);
});

test("an id in another case starts the board's task, spelled as the board spells it", () => {
  const r = repo();
  const { exit, json } = lane(r, "start", "t1");
  assert.equal(exit, 0);
  assert.equal(json.id, "T1");
  assert.equal(json.branch, "agentry/T1");
  assert.equal(ledgerOf(r.root, "T1").id, "T1");
  assert.equal(lane(r, "show", "t1").json.id, "T1");
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

test("a brief recalls this repo's store, user and global facts, never another project's", () => {
  const r = repo({ config: { memory: { prime: "all" } } });
  const home = join(r.home, ".agentry", "memory", "facts");
  mkdirSync(home, { recursive: true });
  const fact = (id, scope, body) =>
    `---\nid: ${id}\ntype: gotcha\n${scope ? `scope: ${scope}\n` : ""}confidence: 0.9\nprovenance:\n  - src/ui/panel.css\n---\n${body}\n`;
  writeFileSync(
    join(home, "u.md"),
    fact("g:01USER", "user", "The owner wants panel.css focus rings."),
  );
  writeFileSync(join(home, "o.md"), fact("g:02OTHER", "repo", "Another repo's panel.css detail."));
  writeFileSync(
    join(home, "n.md"),
    fact("g:03GLOBAL", "global", "A panel.css note from elsewhere."),
  );
  writeFileSync(join(home, "x.md"), fact("g:04NONE", null, "An unscoped panel.css note."));
  const brief = readFileSync(lane(r, "start", "T1").json.brief, "utf8");
  assert.match(brief, /g:01USER/);
  assert.match(brief, /g:03GLOBAL/);
  for (const id of ["g:02OTHER", "g:04NONE"]) assert.doesNotMatch(brief, new RegExp(id));
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

// Lane `id` from start to a verified close, its builder adding `file`.
function verified(r, id, file) {
  let out = lane(r, "start", id).json;
  build(out, file);
  out = lane(r, "report", id).json;
  judge(out, "PASS");
  assert.equal(lane(r, "verdict", id).json.next, "gate");
  assert.equal(lane(r, "gate", id).exit, 0);
  assert.equal(lane(r, "close", id).exit, 0);
}
const merge = ({ root, home }, ...args) =>
  spawnSync("node", [LANE, "merge", ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home },
  });
const ledgerFile = (root, id) => join(root, ".agentry", "run", "process", "ledger", `${id}.json`);

test("a commit on main stops the lane; another lane's real merge does not", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out, "t1.txt");
  verified(r, "T2", "out.txt");
  const landed = merge(r, "T2", "--message", "chore(board): land T2");
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  const res = lane(r, "report", "T1");
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
  assert.deepEqual(row(r.root, "T1"), ["T1", "S1", "verify", "", ""]);

  const r2 = repo();
  build(lane(r2, "start", "T1").json);
  commitFile(r2.root, "plan/NOTES.md", "x\n", "docs: by hand");
  const stopped = lane(r2, "report", "T1");
  assert.equal(stopped.exit, 1);
  assert.match(stopped.json.reason, /main touched: HEAD moved/);
});

test("a ledger without a real merge's shape cannot excuse a commit on main", () => {
  const forged = [
    (sha) => ({ landed: [sha] }),
    (sha, pre) => ({ preHead: pre, landed: [sha], step: "committed", boardCommit: "f".repeat(40) }),
  ];
  for (const record of forged) {
    const r = repo();
    build(lane(r, "start", "T1").json);
    const pre = git(r.root, "rev-parse", "HEAD");
    const sha = commitFile(r.root, "evil.txt", "x\n", "feat: on main");
    writeFileSync(
      ledgerFile(r.root, "ZZ"),
      JSON.stringify({
        v: 1,
        id: "ZZ",
        state: "merged",
        worktree: "/gone",
        merge: record(sha, pre),
      }),
    );
    const res = lane(r, "report", "T1");
    assert.equal(res.exit, 1);
    assert.match(res.json.reason, /main touched: HEAD moved/);
  }
});

test("a builder's edit of main's board outside its lifecycle cells stops the lane", () => {
  const edits = {
    "another row": (text) => text.replace("| T2   | S1     | todo ", "| T2   | S1     | done "),
    "free text": (text) => `${text}\nA paragraph the builder added.\n`,
  };
  for (const [what, edit] of Object.entries(edits)) {
    const r = repo();
    build(lane(r, "start", "T1").json);
    const file = join(r.root, "plan", "BOARD.md");
    writeFileSync(file, edit(readFileSync(file, "utf8")));
    const res = lane(r, "report", "T1");
    assert.equal(res.exit, 1, what);
    assert.match(res.json.reason, /main touched: files changed: {2}M plan\/BOARD\.md/, what);
  }
});

test("a board edit stays caught after another lane's lifecycle write lands on top of it", () => {
  const r = repo();
  build(lane(r, "start", "T1").json);
  const file = join(r.root, "plan", "BOARD.md");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace("| S1     | doing  |", "| S1     | done   |"),
  );
  assert.equal(lane(r, "start", "T2").exit, 0);
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 1);
  assert.match(res.json.reason, /plan\/BOARD\.md/);
});

test("a file dirty when the lane started may stay as it was, but not change further", () => {
  for (const further of [false, true]) {
    const r = repo();
    const tasks = join(r.root, "plan", "TASKS.md");
    writeFileSync(tasks, `${TASKS_MD}\nOwner's draft.\n`);
    build(lane(r, "start", "T1").json);
    if (further) writeFileSync(tasks, `${TASKS_MD}\nOwner's draft.\nAnd more.\n`);
    const res = lane(r, "report", "T1");
    if (further) {
      assert.equal(res.exit, 1);
      assert.match(res.json.reason, /files changed: {2}M plan\/TASKS\.md/);
    } else assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
  }
});

const STORIES = {
  version: 1,
  name: "Files",
  root: ".",
  kinds: {
    story: {
      label: "Story",
      at: { files: "stories/*.md", id: "frontmatter:id" },
      fields: { state: { column: "state" } },
      status: { field: "state", values: { open: "planned", doing: "active", verify: "active" } },
      contract: { blocks: ["TASKS.md"] },
    },
  },
  rules: [],
  lifecycle: {
    kind: "story",
    on: { dispatched: "doing", built: "verify" },
    write: { status: "state" },
  },
};

test("parallel lanes on a one-file-per-item board don't stop each other", () => {
  const r = { root: temp("exec-files-"), home: temp("exec-home-") };
  git(r.root, "init", "-q", "-b", "main");
  commitFile(r.root, ".gitignore", ".agentry/run/\n");
  commitFile(r.root, "stories/s1.md", "---\nid: S-1\nstate: open\n---\n\n# One\n");
  commitFile(r.root, "stories/s2.md", "---\nid: S-2\nstate: open\n---\n\n# Two\n");
  commitFile(r.root, "TASKS.md", "# Tasks\n\n- **S-1**: owns `a.txt`.\n- **S-2**: owns `b.txt`.\n");
  commitFile(r.root, ".agentry/process.json", JSON.stringify(STORIES));
  const one = lane(r, "start", "S-1").json;
  const two = lane(r, "start", "S-2").json;
  build(one, "a.txt");
  build(two, "b.txt");
  const first = lane(r, "report", "S-1");
  assert.equal(first.json.next, "verify", JSON.stringify(first.json.guards));
  const second = lane(r, "report", "S-2");
  assert.equal(second.json.next, "verify", JSON.stringify(second.json.guards));
  assert.match(readFileSync(join(r.root, "stories", "s1.md"), "utf8"), /state: verify/);
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

test("a ledger's boardWrites excuse only the lifecycle's own board file, not another file", () => {
  const r = repo();
  build(lane(r, "start", "T1").json);
  const tasks = join(r.root, "plan", "TASKS.md");
  const from = git(r.root, "hash-object", "plan/TASKS.md");
  writeFileSync(tasks, `${TASKS_MD}\nA contract the builder rewrote.\n`);
  const to = git(r.root, "hash-object", "plan/TASKS.md");
  writeFileSync(
    ledgerFile(r.root, "ZZ"),
    JSON.stringify({
      v: 1,
      id: "ZZ",
      state: "building",
      worktree: "/gone",
      boardWrites: [{ file: "plan/TASKS.md", from, to }],
    }),
  );
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 1, JSON.stringify(res.json));
  assert.match(res.json.reason, /files changed: {2}M plan\/TASKS\.md/);
});

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

test("only new memory records are Agentry's own: other files and edits of tracked ones stop the lane", () => {
  const record = `.agentry/memory/facts/a-fact-${ULID}.md`;
  const cases = {
    "a script in the store": (root) => {
      mkdirSync(join(root, ".agentry", "memory"), { recursive: true });
      writeFileSync(join(root, ".agentry", "memory", "evil.sh"), "echo\n");
    },
    "a record whose name is not a ULID": (root) => {
      mkdirSync(join(root, ".agentry", "memory", "facts"), { recursive: true });
      writeFileSync(join(root, ".agentry", "memory", "facts", "evil.md"), "x\n");
    },
    "a record staged as new": (root) => {
      mkdirSync(join(root, ".agentry", "memory", "facts"), { recursive: true });
      writeFileSync(join(root, ".agentry", "memory", "facts", `staged-${ULID}.md`), "x\n");
      git(root, "add", ".agentry/memory");
    },
    "an edit of a tracked record": (root) => writeFileSync(join(root, record), "changed\n"),
    "a tracked record deleted": (root) => rmSync(join(root, record)),
  };
  for (const [what, act] of Object.entries(cases)) {
    const r = repo();
    commitFile(r.root, record, "a fact\n");
    build(lane(r, "start", "T1").json);
    act(r.root);
    const res = lane(r, "report", "T1");
    assert.equal(res.exit, 1, what);
    assert.match(res.json.reason, /files changed: .*\.agentry\/memory/, what);
  }
});

test("Agentry's own memory writes in main do not stop a building lane", () => {
  const r = repo();
  build(lane(r, "start", "T1").json);
  const dir = join(r.root, ".agentry", "memory", "episodes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `an-episode-${ULID}.md`), "an episode another lane wrote\n");
  const res = lane(r, "report", "T1");
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
});

test("every printed cd prefix and lane line survives a path with quotes, $, backticks and spaces", () => {
  const r = repo({ prefix: 'ex "q" $HOME `id` it\'s ' });
  const out = lane(r, "start", "T1").json;
  const sh = (line) =>
    spawnSync("sh", ["-c", line], { encoding: "utf8", env: { ...gitEnv, HOME: r.home } });
  // the prompt's `cd '<worktree>' &&` prefix lands in the worktree
  const cd = /`(cd .*? &&)`/.exec(out.prompt.split("\n")[1])[1];
  assert.equal(sh(`${cd} pwd`).stdout.trim(), out.worktree);
  // the brief's prefixes do too
  const text = readFileSync(out.brief, "utf8");
  assert.doesNotMatch(text, /cd "/);
  const prefixes = text.match(/cd '.*?' &&/g) ?? [];
  assert.ok(prefixes.length > 0);
  for (const line of prefixes) assert.equal(sh(`${line} pwd`).stdout.trim(), out.worktree, line);
  // the lane line the next step prints runs
  build(out);
  const shown = lane(r, "report", "T1").json;
  judge(shown, "PASS");
  const gated = lane(r, "verdict", "T1").json;
  assert.equal(gated.next, "gate");
  const ran = sh(gated.run);
  assert.equal(JSON.parse(ran.stdout).step, "gate", ran.stdout + ran.stderr);
});

test("an index-only change in main (git rm --cached) stops the lane", () => {
  const r = repo();
  build(lane(r, "start", "T1").json);
  git(r.root, "rm", "-q", "--cached", "plan/DECISIONS.md");
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 1, JSON.stringify(res.json));
  assert.match(res.json.reason, /files changed: .*plan\/DECISIONS\.md/);
});

test("a second close --episode with another id is refused and names the stamped one", () => {
  const r = repo();
  verified(r, "T1", "out.txt");
  lane(r, "close", "T1");
  assert.equal(lane(r, "close", "T1", "--episode", "p:FIRST").exit, 0);
  const again = lane(r, "close", "T1", "--episode", "p:SECOND");
  assert.notEqual(again.exit, 0);
  assert.match(again.stderr + again.stdout, /already stamped as p:FIRST/);
  assert.equal(ledgerOf(r.root, "T1").episode.writtenId, "p:FIRST");
  assert.equal(lane(r, "close", "T1", "--episode", "p:FIRST").exit, 0, "the same id is idempotent");
});

test("a lane whose ledger predates executable ids is not stopped by a pre-modified executable", () => {
  const r = repo();
  commitFile(r.root, "plan/NOTE.txt", "target");
  chmodSync(join(r.root, "plan", "NOTE.txt"), 0o755);
  build(lane(r, "start", "T1").json);
  const path = join(r.root, ".agentry", "run", "process", "ledger", "T1.json");
  const legacy = ledgerOf(r.root, "T1");
  const was = legacy.mainAtStart;
  assert.match(was.files["plan/NOTE.txt"], /:x$/);
  was.files["plan/NOTE.txt"] = was.files["plan/NOTE.txt"].replace(/:x$/, "");
  was.modes = undefined;
  writeFileSync(path, JSON.stringify(legacy));
  const res = lane(r, "report", "T1");
  assert.equal(res.json.next, "verify", JSON.stringify(res.json));
});

test('close accepts a merged ledger (next done, or "" when adopted) and stamps its episode', () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1").json;
  judge(out, "PASS");
  assert.equal(lane(r, "verdict", "T1").json.next, "gate");
  assert.equal(lane(r, "gate", "T1").exit, 0);
  const landed = merge(r, "T1", "--message", "chore(board): land T1");
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  const merged = ledgerOf(r.root, "T1");
  assert.equal(merged.state, "merged");
  assert.equal(merged.episode, undefined);
  writeFileSync(ledgerFile(r.root, "T1"), JSON.stringify({ ...merged, next: "" }));
  const closed = lane(r, "close", "T1");
  assert.equal(closed.exit, 0, closed.stderr);
  assert.equal(closed.json.episode.shape, "exec");
  const stamped = lane(r, "close", "T1", "--episode", "01EP");
  assert.equal(stamped.json.episode.writtenId, "01EP");
});

test("close accepts a stopped lane", () => {
  const r = repo();
  build(lane(r, "start", "T1").json);
  commitFile(r.root, "plan/NOTES.md", "x\n", "docs: by hand");
  assert.equal(lane(r, "report", "T1").exit, 1);
  const closed = lane(r, "close", "T1");
  assert.equal(closed.exit, 0, closed.stderr);
  assert.match(closed.json.episode.outcome, /^stopped/);
});

// ---- Agentry's own memory writes, store NOT ignored (the normal path for a repo that commits it) ----

const MEM = join(dirname(LANE), "..", "mem", "index.js");

// A real `episode_write` through the shipped memory MCP, writing into the repo's `.agentry/memory`.
// Resolves to the episode id.
function episodeWrite({ root, home }, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [MEM], {
      env: { ...gitEnv, HOME: home, CLAUDE_PROJECT_DIR: root, AGENTRY_PROJECT_DIR: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the memory MCP did not answer"));
    }, 20000);
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          send({ method: "notifications/initialized" });
          send({
            id: 2,
            method: "tools/call",
            params: { name: "episode_write", arguments: payload },
          });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(JSON.parse(msg.result.content[0].text).id);
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
  });
}

// Close lane `id`, write its episode for real and stamp the id.
async function closeAndRecord(r, id) {
  const { episode } = lane(r, "close", id).json;
  const { task, shape, outcome } = episode;
  const written = await episodeWrite(r, { task, shape, outcome });
  assert.equal(lane(r, "close", id, "--episode", written).exit, 0);
  return written;
}
const status = (root) => git(root, "status", "--porcelain", "--untracked-files=all");

test("close, a real episode_write, stamp and lane merge land with the store not ignored", async () => {
  const r = repo();
  verified(r, "T1", "out.txt");
  await closeAndRecord(r, "T1");
  assert.match(status(r.root), /^\?\? \.agentry\/memory\/episodes\/.+\.md$/m);
  const landed = merge(r, "T1", "--message", "chore(board): land T1");
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(status(r.root), /^\?\? \.agentry\/memory\/episodes\//m, "left as it was");
});

test("committing the episode between two lanes stops neither, and the land still works", async () => {
  const r = repo();
  const building = lane(r, "start", "T1").json;
  build(building, "t1.txt");
  verified(r, "T2", "out.txt");
  await closeAndRecord(r, "T2");
  git(r.root, "add", ".agentry/memory");
  git(r.root, "commit", "-q", "-m", "chore(memory): record the T2 episode");
  const landed = merge(r, "T2", "--message", "chore(board): land T2");
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  const res = lane(r, "report", "T1");
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
});

test("close on a stamped lane says the episode is written and prints no payload to follow", async () => {
  const r = repo();
  verified(r, "T1", "out.txt");
  const written = await closeAndRecord(r, "T1");
  const again = lane(r, "close", "T1");
  assert.equal(again.exit, 0);
  assert.match(again.json.already, /already|is written/);
  assert.equal(again.json.afterwards, undefined);
  assert.equal(ledgerOf(r.root, "T1").episode.writtenId, written);
});

test("close on an adopted lane says it was not verified by a lane", () => {
  const r = repo();
  git(r.root, "branch", "feat/t1");
  git(r.root, "checkout", "-q", "feat/t1");
  commitFile(r.root, "out.txt", "x\n", "feat: one");
  git(r.root, "checkout", "-q", "main");
  const landed = merge(r, "T1", "--branch", "feat/t1", "--message", "chore(board): land T1");
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  const { outcome } = lane(r, "close", "T1").json.episode;
  assert.doesNotMatch(outcome, /undefined/);
  assert.match(outcome, /^adopted: not built or verified by a lane/);
});

test("a recorded lifecycle write on a file the owner staged does not stop another lane", () => {
  const r = { root: temp("exec-files-"), home: temp("exec-home-") };
  git(r.root, "init", "-q", "-b", "main");
  commitFile(r.root, ".gitignore", ".agentry/run/\n");
  commitFile(r.root, "stories/s1.md", "---\nid: S-1\nstate: open\n---\n\n# One\n");
  commitFile(r.root, "stories/s2.md", "---\nid: S-2\nstate: open\n---\n\n# Two\n");
  commitFile(r.root, "TASKS.md", "# Tasks\n\n- **S-1**: owns `a.txt`.\n- **S-2**: owns `b.txt`.\n");
  commitFile(r.root, ".agentry/process.json", JSON.stringify(STORIES));
  writeFileSync(
    join(r.root, "stories", "s2.md"),
    "---\nid: S-2\nstate: open\n---\n\n# Two, mine\n",
  );
  git(r.root, "add", "stories/s2.md");
  const one = lane(r, "start", "S-1").json;
  build(one, "a.txt");
  assert.equal(lane(r, "start", "S-2").exit, 0);
  assert.match(status(r.root), /^MM stories\/s2\.md$/m);
  const res = lane(r, "report", "S-1");
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
});

test("a new symlink, a dangling one, a type change with the same content and a chmod stop the lane", () => {
  const cases = {
    "a symlink to a directory": (root) => symlinkSync("plan", join(root, "link")),
    "a dangling symlink": (root) => symlinkSync("nowhere", join(root, "link")),
    "a file turned into a symlink with its own text": (root) => {
      rmSync(join(root, "plan", "NOTE.txt"));
      symlinkSync("target", join(root, "plan", "NOTE.txt"));
    },
    "a chmod": (root) => chmodSync(join(root, "plan", "NOTE.txt"), 0o755),
  };
  for (const [what, act] of Object.entries(cases)) {
    const r = repo();
    commitFile(r.root, "plan/NOTE.txt", "target");
    build(lane(r, "start", "T1").json);
    act(r.root);
    const res = lane(r, "report", "T1");
    assert.equal(res.exit, 1, what);
    assert.match(res.json.reason, /main touched: files changed/, what);
  }
});
