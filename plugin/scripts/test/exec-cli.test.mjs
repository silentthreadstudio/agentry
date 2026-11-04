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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  gate: { tiers: [{ name: "full", command: ["sh", "-c", "test -f out.txt"] }] },
};
// The process file whose verifier runs the gate itself (gate.roles.verify "pick").
const VERIFY_GATES = { ...SPEC, gate: { ...SPEC.gate, roles: { verify: "pick" } } };
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
// The spec as the process and workflow files in `.agentry/`, committed.
function commitSpec(root, spec) {
  writeSpec(join(root, ".agentry"), spec);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
}
function repo({
  spec = SPEC,
  config,
  prefix = "exec-repo-",
  decisions = DECISIONS_MD,
  tasks = TASKS_MD,
} = {}) {
  const root = temp(prefix);
  const home = temp("exec-home-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agentry"));
  if (config) writeFileSync(join(root, ".agentry", "config.json"), JSON.stringify(config));
  commitFile(root, ".gitignore", ".agentry/run/\n.agentry/config.json\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", tasks);
  commitFile(root, "plan/DECISIONS.md", decisions);
  commitSpec(root, spec);
  return { root, home };
}
function lane({ root, home }, ...args) {
  const res = spawnSync("node", [LANE, "exec", ...args, "--json", "--root", root], {
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
// A report that found main touched: the lane held for the guard (exit 0, field 75); its trip line.
function tripped(res, what = "") {
  assert.equal(res.exit, 0, `${what} ${res.stderr}`);
  const { state, next, hold } = res.json;
  assert.deepEqual([state, next, hold?.for], ["held", "resume", "guard"], what);
  return res.json.guards[0];
}
// T1 also owns the board's own files: a running lane's owned board file is guarded as any file is.
const OWNS_BOARD = TASKS_MD.replace(
  "owns `out.txt`, `src/ui/panel.css`;",
  "owns `out.txt`, `src/ui/panel.css`, `plan/BOARD.md`, `plan/DECISIONS.md`;",
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
  assert.match(brief, /- `out\.txt` \(new\)\n- `src\/ui\/panel\.css` \(new\)/);
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

test("start warns, without refusing, when its owned files overlap a running lane's", () => {
  const tasks = [
    "# Tasks",
    "",
    "- **T1** (S1): owns `docs/guide/intro.md`, `docs/*.md`, `src/a.ts`. Accept: x.",
    "- **T2** (S1): owns `docs/guide/intro.md`, `docs/{api,faq}.md`, `src/b.ts`. Accept: y.",
    "",
  ].join("\n");
  const r = repo({ tasks, config: { lanes: { maxWriters: 3 } } });
  const first = lane(r, "start", "T1");
  assert.equal(first.exit, 0);
  assert.equal(first.json.warning, undefined, "nothing runs yet, nothing overlaps");
  const second = lane(r, "start", "T2");
  assert.equal(second.exit, 0);
  assert.equal(
    second.json.warning,
    "! owns overlap with T1: docs/guide/intro.md, docs/api.md, docs/faq.md",
  );
  assert.equal(ledgerOf(r.root, "T2").state, "building", "a warning does not stop the lane");
});

test("start names an owns path with a .. segment in its warning and drops it from the owned files", () => {
  const tasks = [
    "# Tasks",
    "",
    "- **T1** (S1): owns `src/a.ts`, `../outside/x.md`, `src/../src/b.ts`, `/build/`. Accept: x.",
    "",
  ].join("\n");
  const r = repo({ tasks });
  const started = lane(r, "start", "T1");
  assert.equal(started.exit, 0);
  assert.equal(
    started.json.warning,
    [
      "! owns names a path outside the repository: ../outside/x.md (dropped)",
      "! owns names a path outside the repository: src/../src/b.ts (dropped)",
    ].join("\n"),
  );
  assert.deepEqual(
    started.json.owned.map((o) => o.path),
    ["src/a.ts"],
  );
});

test("start warns when the owns clause names tests but no owned path is a test file", () => {
  const tasks = [
    "# Tasks",
    "",
    "- **T1** (S1): owns `src/a.ts` and its tests. Accept: x.",
    "- **T2** (S1): owns `src/b.ts` and its tests in `test/b.test.ts`. Accept: y.",
    "",
  ].join("\n");
  const r = repo({ tasks, config: { lanes: { maxWriters: 3 } } });
  assert.equal(
    lane(r, "start", "T1").json.warning,
    "! owns names tests but no test file: add the test paths (exec owns <id> --set … --apply)",
  );
  assert.equal(lane(r, "start", "T2").json.warning, undefined);
});

test("start's overlap warning ignores a lane that is closed, and one with no shared file", () => {
  const tasks = [
    "# Tasks",
    "",
    "- **T1** (S1): owns `src/a.ts`. Accept: x.",
    "- **T2** (S1): owns `src/b.ts`. Accept: y.",
    "",
  ].join("\n");
  const r = repo({ tasks, config: { lanes: { maxWriters: 3 } } });
  assert.equal(lane(r, "start", "T1").exit, 0);
  const ledgerFile = join(r.root, ".agentry", "run", "process", "ledger", "T1.json");
  const ledger = ledgerOf(r.root, "T1");
  ledger.owned = [{ path: "src/b.ts", new: true }];
  ledger.state = "closed";
  writeFileSync(ledgerFile, JSON.stringify(ledger));
  const started = lane(r, "start", "T2");
  assert.equal(started.exit, 0);
  assert.equal(started.json.warning, undefined);
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
  // gate.roles.verify defaults to none: the verifier runs no gate; the lane runs the build tier after it.
  const verifyBrief = readFileSync(out.brief, "utf8");
  assert.match(
    verifyBrief,
    /- The gate is not yours: the lane records the full tier and the land runs the merge tier\. Run only your own probes\./,
  );
  assert.doesNotMatch(verifyBrief, /exec gate T1 --root/);

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

test("a builder that changes the main checkout holds the lane for the guard (exit 0) and names it", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out);
  const tree = status(out.worktree);
  writeFileSync(join(r.root, "stray.txt"), "oops\n");
  const res = lane(r, "report", "T1");
  assert.match(tripped(res), /^main touched: files changed: \?\? stray\.txt$/);
  const saved = out.reportPath.replace(/\.md$/, ".held.md");
  assert.deepEqual(res.json.hold, {
    for: "guard",
    when: "during",
    stepRun: null,
    evidence: saved,
    reason: "files changed: ?? stray.txt",
    report: saved,
    since: res.json.hold.since,
    round: 1,
  });
  assert.equal(readFileSync(saved, "utf8"), readFileSync(out.reportPath, "utf8"));
  assert.equal(status(out.worktree), tree, "nothing in the worktree changes");
  assert.deepEqual(row(r.root, "T1"), ["T1", "S1", "doing", "", ""], "no `built` on a hold");
  const shown = lane(r, "show", "T1");
  assert.equal(shown.exit, 0);
  assert.equal(shown.json.hold.for, "guard");
});

test("close takes the episode's task line from the last build report, not a needs-context one", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  writeFileSync(out.reportPath, "NEEDS_CONTEXT\nasked which file\nused_memories: none\n");
  out = lane(r, "report", "T1").json;
  assert.equal(out.role, "build");
  build(out);
  out = lane(r, "report", "T1").json;
  judge(out, "PASS");
  assert.equal(lane(r, "verdict", "T1").json.next, "gate");
  assert.equal(lane(r, "gate", "T1").exit, 0);
  assert.equal(lane(r, "close", "T1").json.episode.task, "T1: added out.txt");
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

// The land trusts the newest worktree gate of its tier on the tip, whatever its exit: a red run after a
// green one makes the land run the gate on main; a flaky red with a green re-run after it still skips.
test("a red gate after a green one on the same tip and tier makes the land run the gate on main", () => {
  const spec = {
    ...SPEC,
    gate: {
      tiers: [{ name: "full", command: ["sh", "-c", 'test -f out.txt && test ! -f "$HOME/red"'] }],
    },
  };
  const r = repo({ spec });
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1").json;
  judge(out, "PASS");
  assert.equal(lane(r, "verdict", "T1").json.next, "gate");
  assert.equal(lane(r, "gate", "T1").exit, 0);
  writeFileSync(join(r.home, "red"), "");
  // Run again on the same tip once the lane is set to close: red, recorded, and the lane still closes.
  assert.equal(lane(r, "gate", "T1").exit, 1);
  rmSync(join(r.home, "red"));
  const gates = ledgerOf(r.root, "T1").gates.map((g) => [g.tier, g.exit]);
  assert.deepEqual(gates.at(-1), ["full", 1]);
  assert.equal(lane(r, "close", "T1").exit, 0);
  const pf = merge(r, "T1", "--preflight");
  assert.match(pf.stdout, /worktree gate: full exit 1/, pf.stdout + pf.stderr);
  const landed = merge(r, "T1", "--message", "chore(board): land T1");
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.stdout, /full ran on main: exit 0/);
  assert.match(landed.stdout, /not skipped: the recorded gate exited 1/);
});

test("a flaky red with a green re-run after it still lets the land skip the gate", () => {
  const marker = join(temp("flaky-"), "ran");
  const r = atGate(flakyGate(marker));
  assert.equal(lane(r, "gate", "T1").exit, 0);
  assert.deepEqual(
    ledgerOf(r.root, "T1").gates.map((g) => g.exit),
    [1, 0],
  );
  assert.equal(lane(r, "close", "T1").exit, 0);
  const pf = merge(r, "T1", "--preflight");
  assert.match(pf.stdout, /worktree gate: full exit 0/, pf.stdout + pf.stderr);
  const landed = merge(r, "T1", "--message", "chore(board): land T1");
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.stdout, /skipped: gate on [0-9a-f]{7}, tree identical/);
});

test("a commit on main touching the lane's files holds it; another lane's real merge does not", () => {
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
  const sha = commitFile(r2.root, "src/ui/panel.css", "x\n", "style: by hand");
  assert.match(
    tripped(lane(r2, "report", "T1")),
    new RegExp(
      `^main touched: HEAD moved [0-9a-f]{7} → [0-9a-f]{7} \\(${sha.slice(0, 7)} touches src/ui/panel\\.css, this lane's files\\)$`,
    ),
  );
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
    const sha = commitFile(r.root, "src/ui/panel.css", "x\n", "feat: on main");
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
    assert.match(tripped(lane(r, "report", "T1")), /main touched: HEAD moved/);
  }
});

test("a builder's edit of a board file a running lane owns, outside its lifecycle cells, trips", () => {
  const edits = {
    "another row": (text) => text.replace("| T2   | S1     | todo ", "| T2   | S1     | done "),
    "free text": (text) => `${text}\nA paragraph the builder added.\n`,
  };
  for (const [what, edit] of Object.entries(edits)) {
    const r = repo({ tasks: OWNS_BOARD });
    build(lane(r, "start", "T1").json);
    const file = join(r.root, "plan", "BOARD.md");
    writeFileSync(file, edit(readFileSync(file, "utf8")));
    const res = lane(r, "report", "T1");
    assert.match(tripped(res, what), /main touched: files changed: {2}M plan\/BOARD\.md/, what);
  }
});

test("an owned board file's edit stays caught after another lane's lifecycle write lands on top of it", () => {
  const r = repo({ tasks: OWNS_BOARD });
  build(lane(r, "start", "T1").json);
  const file = join(r.root, "plan", "BOARD.md");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace("| S1     | doing  |", "| S1     | done   |"),
  );
  assert.equal(lane(r, "start", "T2").exit, 0);
  assert.match(tripped(lane(r, "report", "T1")), /plan\/BOARD\.md/);
});

test("a file dirty when the lane started may stay as it was, but not change further", () => {
  for (const further of [false, true]) {
    const r = repo();
    commitFile(r.root, "README.md", "# Readme\n");
    const readme = join(r.root, "README.md");
    writeFileSync(readme, "# Readme\n\nOwner's draft.\n");
    build(lane(r, "start", "T1").json);
    if (further) writeFileSync(readme, "# Readme\n\nOwner's draft.\nAnd more.\n");
    const res = lane(r, "report", "T1");
    if (further) assert.match(tripped(res), /files changed: {2}M README\.md/);
    else assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
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
  commitSpec(r.root, STORIES);
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

const RULES = { commits: { subjectMax: 72, forbid: ["^Co-Authored-By:"] } };
const REWORD =
  "→ reword it on the branch (git commit --amend for the tip, or a rebase with exec, no -i)";
const LONG = `feat: ${"x".repeat(74)}`;

test("a builder commit that breaks a commits rule sends a fix round with the reason; a reworded one goes on", () => {
  const r = repo({ spec: { ...SPEC, ...RULES } });
  const out = lane(r, "start", "T1").json;
  commitFile(out.worktree, "out.txt", "made\n", LONG);
  writeFileSync(out.reportPath, "DONE\nadded out.txt\nused_memories: none\n");
  const sha = git(out.worktree, "rev-parse", "--short=7", "HEAD");
  const res = lane(r, "report", "T1", "--agent", "b1");
  assert.equal(res.exit, 0);
  assert.equal(res.json.next, "fix");
  const reason = `commit ${sha} "${LONG}": subject is 80 chars (commits.subjectMax 72) ${REWORD}`;
  assert.equal(res.json.why, reason);
  assert.deepEqual(res.json.guards, [reason]);
  assert.match(readFileSync(res.json.brief, "utf8"), /The lane refused your last report/);
  assert.ok(readFileSync(res.json.brief, "utf8").includes(reason));
  // The builder rewords the tip commit: the lane goes on to the verifier.
  git(out.worktree, "commit", "--amend", "-q", "-m", "feat: add out.txt");
  writeFileSync(res.json.reportPath, "DONE\nreworded\nused_memories: none\n");
  const again = lane(r, "report", "T1", "--agent", "b1");
  assert.equal(again.exit, 0);
  assert.equal(again.json.next, "verify");
  assert.deepEqual(again.json.guards, []);
});

test("a second report still breaking a commits rule stops the lane (exit 1)", () => {
  const r = repo({ spec: { ...SPEC, ...RULES } });
  const out = lane(r, "start", "T1").json;
  commitFile(out.worktree, "out.txt", "made\n", LONG);
  writeFileSync(out.reportPath, "DONE\nx\nused_memories: none\n");
  const first = lane(r, "report", "T1", "--agent", "b1");
  assert.equal(first.json.next, "fix");
  writeFileSync(first.json.reportPath, "DONE\nstill\nused_memories: none\n");
  const second = lane(r, "report", "T1", "--agent", "b1");
  assert.equal(second.exit, 1);
  assert.equal(second.json.next, "stop");
  assert.match(second.json.reason, /again after a fix for it/);
});

test("a forbid match in a commit's trailer is refused, and with no commits key nothing is checked", () => {
  const r = repo({ spec: { ...SPEC, ...RULES } });
  const out = lane(r, "start", "T1").json;
  git(
    out.worktree,
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "feat: x",
    "-m",
    "a\nb\nCo-Authored-By: Q <q@x.y>",
  );
  writeFileSync(out.reportPath, "DONE\nx\nused_memories: none\n");
  const res = lane(r, "report", "T1", "--agent", "b1");
  assert.equal(res.json.next, "fix");
  assert.match(res.json.why, /"feat: x": message matches commits\.forbid\[0\] →/);
  // The same commits under a workflow file with no `commits`: the lane goes on.
  const free = repo();
  const o2 = lane(free, "start", "T1").json;
  commitFile(o2.worktree, "out.txt", "made\n", LONG);
  writeFileSync(o2.reportPath, "DONE\nx\nused_memories: none\n");
  assert.equal(lane(free, "report", "T1", "--agent", "b1").json.next, "verify");
});

test("a dirty worktree and a bad subject are named in one fix round", () => {
  const r = repo({ spec: { ...SPEC, ...RULES } });
  const out = lane(r, "start", "T1").json;
  commitFile(out.worktree, "out.txt", "made\n", LONG);
  writeFileSync(join(out.worktree, "left.txt"), "x\n");
  writeFileSync(out.reportPath, "DONE\nx\nused_memories: none\n");
  const res = lane(r, "report", "T1", "--agent", "b1");
  assert.equal(res.json.next, "fix");
  assert.match(
    res.json.why,
    /uncommitted files in the worktree: \?\? left\.txt; commit [0-9a-f]{7} "feat: x+"/,
  );
  assert.equal(res.json.guards.length, 2);
});

test("30 broken commits give one fix round that lists 5 of them, then +25", () => {
  const r = repo({ spec: { ...SPEC, ...RULES } });
  const out = lane(r, "start", "T1").json;
  for (let i = 0; i < 30; i++)
    git(out.worktree, "commit", "--allow-empty", "-q", "-m", `${LONG}${i}`);
  writeFileSync(out.reportPath, "DONE\nx\nused_memories: none\n");
  const res = lane(r, "report", "T1", "--agent", "b1");
  assert.equal(res.json.next, "fix");
  assert.equal(res.json.guards.length, 6);
  assert.deepEqual(
    res.json.guards.slice(0, 5).map((g) => /^commit [0-9a-f]{7} "feat: x+(\d+)": /.exec(g)?.[1]),
    ["0", "1", "2", "3", "4"],
  );
  assert.equal(res.json.guards[5], "+25");
  assert.equal(ledgerOf(r.root, "T1").rounds.length, 2, "one fix round");
});

test("repo policy lines ride in the build brief and the verify brief, each role its own", () => {
  const briefs = { build: ["Use pnpm; `npm` is {{id}}."], verify: ["Read | the changelog."] };
  const r = repo({ spec: { ...SPEC, briefs } });
  const out = lane(r, "start", "T1").json;
  const head = "## Repo policy (overrides the contract where they differ)";
  const buildBrief = readFileSync(out.brief, "utf8");
  assert.ok(buildBrief.includes(`${head}\n\n- Use pnpm; \`npm\` is {{id}}.\n\nOwned files:`));
  assert.doesNotMatch(buildBrief, /changelog/);
  build(out);
  const verify = lane(r, "report", "T1", "--agent", "b1").json;
  const verifyBrief = readFileSync(verify.brief, "utf8");
  assert.ok(verifyBrief.includes(`${head}\n\n- Read | the changelog.\n\nOwned files:`));
  assert.doesNotMatch(verifyBrief, /pnpm/);
  // Only one role set: the other gets no section.
  const half = repo({ spec: { ...SPEC, briefs: { verify: ["v"] } } });
  assert.doesNotMatch(readFileSync(lane(half, "start", "T1").json.brief, "utf8"), /Repo policy/);
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
  const r = repo({ spec: VERIFY_GATES });
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

test("a worktree inside the lane's own worktree is nested; one made elsewhere is not", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out);
  const nested = join(out.worktree, "nested-x");
  git(r.root, "worktree", "add", "-q", "-b", "nested-x", nested);
  const conductors = join(r.root, ".claude", "worktrees", "agent-1");
  git(r.root, "worktree", "add", "-q", "-b", "agent-1", conductors);
  const res = lane(r, "report", "T1");
  assert.deepEqual(res.json.nested, [nested]);
  assert.deepEqual(ledgerOf(r.root, "T1").nested, [nested]);
});

test("writers: kept worktrees and the host's agent worktrees without a ledger do not count", () => {
  const r = repo({
    spec: { ...SPEC, worktrees: { keep: ["kept-*"] } },
    config: { lanes: { maxWriters: 2 } },
  });
  const kept = join(r.root, "..", `${r.root.split("/").at(-1)}-kept`);
  git(r.root, "worktree", "add", "-q", "-b", "kept-branch", kept);
  temps.push(kept);
  git(r.root, "worktree", "add", "-q", "-b", "agent-1", join(r.root, ".claude", "worktrees", "a1"));
  assert.equal(lane(r, "start", "T1").exit, 0);
  assert.equal(lane(r, "start", "T2").exit, 0, "T1 is the only writer");
});

test("start prints readable text by default and the one JSON object under --json", () => {
  const r = repo();
  const res = spawnSync("node", [LANE, "exec", "start", "T1", "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^T1 · start → build \(building\)\n/);
  assert.match(res.stdout, /^prompt:\n {2}agentry-task: T1 role=build round=1\n/m);
  assert.match(
    res.stdout,
    /^owned files \(parsed from the contract\):\n {2}- out\.txt \(new\)\n {2}- src\/ui\/panel\.css \(new\)\n {2}amend: .*exec owns T1 /m,
  );
  assert.throws(() => JSON.parse(res.stdout));
});

test("owns shows the parsed list, a --set previews until --apply, and the waiting brief is rewritten", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  assert.deepEqual(ledgerOf(r.root, "T1").owned, [
    { path: "out.txt", new: true },
    { path: "src/ui/panel.css", new: true },
  ]);
  const before = readFileSync(out.brief, "utf8");
  const preview = lane(r, "owns", "T1", "--set", "a/b.ts,c.ts");
  assert.equal(preview.exit, 0);
  assert.equal(preview.json.applied, false);
  assert.match(preview.json.preview, /^preview: nothing written; add --apply/);
  assert.equal(readFileSync(out.brief, "utf8"), before, "a preview writes nothing");
  assert.equal(ledgerOf(r.root, "T1").owned.length, 2);

  const done = lane(r, "owns", "T1", "--set", "a/b.ts, c.ts,plan/TASKS.md", "--apply");
  assert.equal(done.exit, 0);
  assert.deepEqual(ledgerOf(r.root, "T1").owned, [
    { path: "a/b.ts", new: true },
    { path: "c.ts", new: true },
    { path: "plan/TASKS.md", new: false },
  ]);
  const brief = readFileSync(out.brief, "utf8");
  assert.match(brief, /- `a\/b\.ts` \(new\)\n- `c\.ts` \(new\)\n- `plan\/TASKS\.md`\n/);
  assert.doesNotMatch(brief, /panel\.css`\n/);
  assert.equal(lane(r, "owns", "T1").json.owned.length, 3);
});

test("a later round's brief reads the amended list, not the contract again", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  assert.equal(lane(r, "owns", "T1", "--set", "out.txt", "--apply").exit, 0);
  build(out);
  const verify = lane(r, "report", "T1").json;
  const brief = readFileSync(verify.brief, "utf8");
  assert.match(brief, /Owned files:\n- `out\.txt` \(new\)\n/);
  assert.doesNotMatch(brief, /^- `src\/ui\/panel\.css`/m);
});

test("owns refuses a blank path, --apply without --set, and --set on another step", () => {
  const r = repo();
  lane(r, "start", "T1");
  assert.match(lane(r, "owns", "T1", "--set", "a.ts,,b.ts").stderr, /no blanks/);
  assert.match(lane(r, "owns", "T1", "--apply").stderr, /--apply writes the --set list/);
  assert.match(lane(r, "show", "T1", "--set", "a.ts").stderr, /show takes no --set/);
});

test("a ledger's boardWrites excuse only the lifecycle's own board file, not another file", () => {
  const r = repo();
  commitFile(r.root, "README.md", "# Readme\n");
  build(lane(r, "start", "T1").json);
  const from = git(r.root, "hash-object", "README.md");
  writeFileSync(join(r.root, "README.md"), "# Readme\n\nA line the builder wrote.\n");
  const to = git(r.root, "hash-object", "README.md");
  writeFileSync(
    ledgerFile(r.root, "ZZ"),
    JSON.stringify({
      v: 1,
      id: "ZZ",
      state: "building",
      worktree: "/gone",
      boardWrites: [{ file: "README.md", from, to }],
    }),
  );
  assert.match(tripped(lane(r, "report", "T1")), /files changed: {2}M README\.md/);
});

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

test("anything under .agentry/memory passes the guard, uncommitted or committed (field 78)", () => {
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
    assert.equal(res.json?.next, "verify", `${what}: ${JSON.stringify(res.json?.guards)}`);
    assert.deepEqual(res.json.guards, [], what);
  }
  const r = repo();
  commitFile(r.root, record, "a fact\n");
  build(lane(r, "start", "T1").json);
  writeFileSync(join(r.root, record), "reinforced\n");
  mkdirSync(join(r.root, ".agentry", "memory", "index"), { recursive: true });
  writeFileSync(join(r.root, ".agentry", "memory", "index", "db.json"), "{}\n");
  git(r.root, "add", ".agentry/memory");
  git(r.root, "commit", "-q", "-m", "chore(memory): reinforce a fact");
  const res = lane(r, "report", "T1");
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
  assert.match(res.json.guards[0], /^main moved by allowed commits: 1 /);
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
  const ran = sh(`${gated.run} --json`);
  assert.equal(JSON.parse(ran.stdout).step, "gate", ran.stdout + ran.stderr);
});

test("an index-only change in main (git rm --cached) trips the guard", () => {
  const r = repo();
  commitFile(r.root, "README.md", "# Readme\n");
  build(lane(r, "start", "T1").json);
  git(r.root, "rm", "-q", "--cached", "README.md");
  assert.match(tripped(lane(r, "report", "T1")), /files changed: .*README\.md/);
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

test("close --episode says whether the memory store holds the episode it stamps", () => {
  const r = repo();
  verified(r, "T1", "out.txt");
  lane(r, "close", "T1");
  const unknown = lane(r, "close", "T1", "--episode", "p:01NOSUCH");
  assert.equal(unknown.exit, 0);
  assert.equal(unknown.json.stored, false);
  assert.match(unknown.json.warning, /no episode p:01NOSUCH in the memory store/);

  const s = repo();
  verified(s, "T1", "out.txt");
  lane(s, "close", "T1");
  const episodes = join(s.root, ".agentry", "memory", "episodes");
  mkdirSync(episodes, { recursive: true });
  writeFileSync(join(episodes, "t1-added-out-01KNOWN.md"), "---\nid: p:01KNOWN\n---\n\nT1\n");
  const known = lane(s, "close", "T1", "--episode", "p:01KNOWN");
  assert.equal(known.json.stored, true);
  assert.equal(known.json.warning, undefined);
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
  build(lane(r, "start", "T1").json, "out.txt", "BLOCKED");
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
  commitSpec(r.root, STORIES);
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

test("a new symlink, a dangling one, a type change with the same content and a chmod trip the guard", () => {
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
    assert.match(tripped(lane(r, "report", "T1"), what), /main touched: files changed/, what);
  }
});

// The process file's gate with `command` as its one tier, and the other gate keys in `more`.
const oneTier = ({ command, ...more }) => ({ tiers: [{ name: "full", command }], ...more });
// A lane built and verified (PASS) up to the gate step; `gate` is the process file's gate (`command` its one
// tier when it has no `tiers`).
function atGate(gate, verdict = "PASS") {
  const r = repo({ spec: { ...SPEC, gate: gate.tiers ? gate : oneTier(gate) } });
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1", "--agent", "builder-1").json;
  judge(out, verdict);
  assert.equal(lane(r, "verdict", "T1", "--agent", "verifier-1").json.next, "gate");
  return r;
}
const flakyGate = (marker, line = "FAILED test_budget") => ({
  command: [
    "sh",
    "-c",
    `test -f out.txt && if [ -f '${marker}' ]; then exit 0; else touch '${marker}'; echo '${line}'; exit 1; fi`,
  ],
  flaky: ["test_budget"],
});

test("the gate runs holding the gate lock and leaves none behind", () => {
  const r = atGate({ command: ["sh", "-c", "test -f ../../gate-locks/slot-1.lock"] });
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 0, gated.stderr);
  assert.equal(gated.json.next, "close");
  assert.equal(existsSync(join(r.root, ".agentry", "run", "gate-locks", "slot-1.lock")), false);
});

test("a gate lock left by a dead process does not block the gate", () => {
  const r = atGate(SPEC.gate);
  const dir = join(r.root, ".agentry", "run", "gate-locks");
  mkdirSync(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", "0"]);
  writeFileSync(join(dir, "slot-1.lock"), JSON.stringify({ pid: dead.pid ?? 999999, who: "x" }));
  assert.equal(lane(r, "gate", "T1").exit, 0);
});

test("a red in listed flaky tests only is re-run alone once; both runs are recorded; green accepts", () => {
  const marker = join(temp("flaky-"), "ran");
  const r = atGate(flakyGate(marker));
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 0, gated.stderr);
  assert.equal(gated.json.next, "close");
  assert.deepEqual(gated.json.gate.flaky, ["test_budget"]);
  assert.equal(gated.json.gate.runs, 2);
  assert.ok(gated.json.gate.log.endsWith("logs/gate-2.log"));
  assert.equal(gated.json.gates, "1 green, 1 red on this tip (1 red only in flaky tests)");
  const gates = ledgerOf(r.root, "T1").gates;
  assert.deepEqual(
    gates.map((g) => [g.exit, g.flakyRed ?? null, g.rerun ?? false]),
    [
      [1, ["test_budget"], false],
      [0, null, true],
    ],
  );
});

test("a red that also fails an unlisted test is not re-run: the lane stops", () => {
  const marker = join(temp("flaky-"), "ran");
  const r = atGate(flakyGate(marker, "FAILED test_real_bug"));
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 1);
  assert.equal(gated.json.next, "stop");
  assert.equal(ledgerOf(r.root, "T1").gates.length, 1);
  assert.equal(gated.json.gates, "0 green, 1 red on this tip");
});

test("a flaky red that fails again on the alone re-run stops the lane, both runs recorded", () => {
  const r = atGate({
    command: ["sh", "-c", "test -f out.txt && echo 'FAILED test_budget' && exit 1"],
    flaky: ["test_budget"],
  });
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 1);
  assert.equal(gated.json.next, "stop");
  assert.equal(ledgerOf(r.root, "T1").gates.length, 2);
  assert.equal(gated.json.gates, "0 green, 2 red on this tip (1 red only in flaky tests)");
});

// A gate whose own output is only a summary: the failing name is in a step log under the temp directory
// (written while the gate runs unless `stale`), which `gate.flakyLogs` points at.
function stepLogGate({ names = "FAILED TEST: suite/test_budget", stale = false, logs }) {
  const dir = join(tmpdir(), `agentry-steplog-${process.pid}-${temps.length}`);
  temps.push(dir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "tests.log");
  const marker = join(temp("steplog-"), "ran");
  if (stale) {
    writeFileSync(file, `${names}\n`);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(file, old, old);
  }
  const write = stale ? "" : `printf '${names}\\n' > '${file}'; `;
  return {
    command: [
      "sh",
      "-c",
      `test -f out.txt && if [ -f '${marker}' ]; then exit 0; else touch '${marker}'; ${write}echo 'tests FAIL TESTS: 3 passed, 1 failed'; echo 'GATE: FAILED (1 step(s))'; exit 1; fi`,
    ],
    flaky: ["test_budget"],
    ...(logs !== false && { flakyLogs: logs ?? [`$TMPDIR/${basename(dir)}/tests.log`] }),
  };
}

test("a summary-only gate log plus gate.flakyLogs finds the flaky name and re-runs", () => {
  const r = atGate(stepLogGate({}));
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 0, gated.stderr);
  assert.deepEqual(gated.json.gate.flaky, ["test_budget"]);
  assert.equal(ledgerOf(r.root, "T1").gates.length, 2);
});

test("without gate.flakyLogs the same summary-only red is real", () => {
  const r = atGate(stepLogGate({ logs: false }));
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 1);
  assert.equal(ledgerOf(r.root, "T1").gates.length, 1);
});

test("a flakyLogs file older than the gate run never decides a red", () => {
  const r = atGate(stepLogGate({ stale: true }));
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 1);
  assert.equal(ledgerOf(r.root, "T1").gates.length, 1);
});

test("engine noise in a step log does not turn a named flaky failure into a real red", () => {
  const names = "ERROR: GodRays: holo is not a light preset\\nFAILED TEST: suite/test_budget";
  const r = atGate(stepLogGate({ names }));
  assert.equal(lane(r, "gate", "T1").exit, 0);
  assert.equal(ledgerOf(r.root, "T1").gates.length, 2);
});

test("a step log that names an unlisted failing test keeps the red real", () => {
  const names = "FAILED TEST: suite/test_budget\\nnot ok 4 - suite/test_real";
  const r = atGate(stepLogGate({ names }));
  assert.equal(lane(r, "gate", "T1").exit, 1);
  assert.equal(ledgerOf(r.root, "T1").gates.length, 1);
});

test("a step log whose failures name no test (only noise) keeps the red real", () => {
  const r = atGate(stepLogGate({ names: "ERROR: GodRays: holo is not a light preset" }));
  assert.equal(lane(r, "gate", "T1").exit, 1);
  assert.equal(ledgerOf(r.root, "T1").gates.length, 1);
});

test("flakyLogs never turns a red the gate's own output names as flaky into a real one", () => {
  const dirless = stepLogGate({ names: "ERROR: GodRays: holo is not a light preset" });
  const r = atGate({
    ...dirless,
    command: [
      "sh",
      "-c",
      `test -f out.txt && if [ -f '${join(temp("own-"), "ran")}' ]; then exit 0; else echo 'FAILED TEST: suite/test_budget'; exit 1; fi`,
    ],
  });
  // the gate never passes (its marker is never made): that it ran twice is what is asserted
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 1);
  assert.equal(ledgerOf(r.root, "T1").gates.length, 2);
  assert.deepEqual(gated.json.gate.flaky, ["test_budget"]);
});

// A49: FAILED <name>, a <path>::<test> token and a JSON test event, in the gate's own log and in a step log.
for (const line of [
  "FAILED tests/test_a.py::test_budget - AssertionError",
  "tests/test_a.py::test_budget ERROR",
  '{"test":"test_budget","outcome":"failed"}',
]) {
  test(`the own log's ${JSON.stringify(line)} is a flaky red: re-run alone`, () => {
    const r = atGate(flakyGate(join(temp("flaky-"), "ran"), line));
    const gated = lane(r, "gate", "T1");
    assert.equal(gated.exit, 0, gated.stderr);
    assert.deepEqual(gated.json.gate.flaky, ["test_budget"]);
    assert.equal(ledgerOf(r.root, "T1").gates.length, 2);
  });
  test(`a step log's ${JSON.stringify(line)} is a flaky red: re-run alone`, () => {
    const r = atGate(stepLogGate({ names: line }));
    assert.equal(lane(r, "gate", "T1").exit, 0);
    assert.equal(ledgerOf(r.root, "T1").gates.length, 2);
  });
}

test("FAILED other_test (unlisted) stays a real red, in the own log and in a step log", () => {
  const own = atGate(flakyGate(join(temp("flaky-"), "ran"), "FAILED other_test - E"));
  assert.equal(lane(own, "gate", "T1").exit, 1);
  assert.equal(ledgerOf(own.root, "T1").gates.length, 1);
  const step = atGate(stepLogGate({ names: "FAILED other_test - E" }));
  assert.equal(lane(step, "gate", "T1").exit, 1);
  assert.equal(ledgerOf(step.root, "T1").gates.length, 1);
});

test("a log a killed gate left under the next number is not written into or read as this run's", () => {
  const r = atGate({
    command: ["sh", "-c", "test -f out.txt && echo 'tests FAIL TESTS: 3 passed, 1 failed'; exit 1"],
    flaky: ["test_budget"],
  });
  const logs = join(r.root, ".agentry", "run", "process", "runs", "T1", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "gate-1.log"), "FAILED test_budget\n");
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 1);
  assert.equal(
    ledgerOf(r.root, "T1").gates.length,
    1,
    "a stale failure line made it a flaky re-run",
  );
  assert.equal(readFileSync(join(logs, "gate-1.log"), "utf8"), "FAILED test_budget\n");
  assert.ok(gated.json.gate.log.endsWith("logs/gate-2.log"));
});

test("a gate that waits for its slot says so in its log, before the gate ends", async () => {
  const r = atGate({ command: ["sh", "-c", "test -f out.txt && echo ran"] });
  const locks = join(r.root, ".agentry", "run", "gate-locks");
  mkdirSync(locks, { recursive: true });
  const holder = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  writeFileSync(
    join(locks, "slot-1.lock"),
    JSON.stringify({ pid: holder.pid, who: "lane T9", at: new Date().toISOString() }),
  );
  const log = join(r.root, ".agentry", "run", "process", "runs", "T1", "logs", "gate-1.log");
  const child = spawn("node", [LANE, "exec", "gate", "T1", "--json", "--root", r.root], {
    env: { ...gitEnv, HOME: r.home },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const text = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  try {
    for (let i = 0; i < 500 && !text().includes("waiting for gate slot 1"); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(text(), /waiting for gate slot 1 \(held by lane T9 since \d\d:\d\d\)/);
    assert.equal(child.exitCode, null);
    holder.kill("SIGKILL");
    assert.equal(await exited, 0);
    assert.match(text(), /slot acquired\nran\n/);
  } finally {
    holder.kill("SIGKILL");
    child.kill("SIGKILL");
  }
});

// Two tiers: `tests` when the change is out.txt alone, else `full`; `roles` as given.
const TIERED = (roles) => ({
  ...SPEC,
  gate: {
    tiers: [
      { name: "tests", command: ["sh", "-c", "test -f out.txt"], when: { only: ["out.txt"] } },
      { name: "full", command: ["sh", "-c", "test -f out.txt && true"] },
    ],
    ...(roles && { roles }),
  },
});

test("exec gate after the verdict runs the build role's tier and records role, tier and command", () => {
  const r = repo({ spec: TIERED() });
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1").json;
  judge(out, "PASS");
  assert.equal(lane(r, "verdict", "T1").json.next, "gate");
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 0, gated.stderr);
  assert.equal(gated.json.gate.role, "build");
  assert.equal(gated.json.gate.tier, "tests");
  assert.match(gated.json.gate.why, /^tests: every changed file \(1\) matches its "only"$/);
  const [record] = ledgerOf(r.root, "T1").gates;
  assert.deepEqual(
    [record.where, record.role, record.tier, record.command],
    ["worktree", "build", "tests", ["sh", "-c", "test -f out.txt"]],
  );
});

test("under gate.roles.verify none, exec gate while a verifier is out exits 2 and runs nothing", () => {
  const r = repo({ spec: TIERED() });
  const out = lane(r, "start", "T1").json;
  build(out);
  const reported = lane(r, "report", "T1").json;
  assert.equal(reported.next, "verify");
  assert.match(
    readFileSync(reported.brief, "utf8"),
    /- The gate is not yours: the lane records the tests tier and the land runs the merge tier\. Run only your own probes\./,
  );
  const before = readFileSync(
    join(r.root, ".agentry", "run", "process", "ledger", "T1.json"),
    "utf8",
  );
  const res = lane(r, "gate", "T1");
  assert.equal(res.exit, 2);
  assert.match(
    res.stderr,
    /gate\.roles\.verify is "none": the verifier reads the recorded gate; the lane runs the build tier after the verdict/,
  );
  assert.equal(
    readFileSync(join(r.root, ".agentry", "run", "process", "ledger", "T1.json"), "utf8"),
    before,
  );
  assert.equal(existsSync(join(r.root, ".agentry", "run", "gate-locks")), false);
  assert.equal(
    existsSync(join(r.root, ".agentry", "run", "process", "runs", "T1", "logs", "gate-1.log")),
    false,
  );
});

test("with gate.roles.verify set, exec gate while a verifier is out runs the verify tier", () => {
  const r = repo({ spec: TIERED({ verify: "full" }) });
  const out = lane(r, "start", "T1").json;
  build(out);
  const reported = lane(r, "report", "T1").json;
  assert.match(readFileSync(reported.brief, "utf8"), /Run the gate as the lane records it/);
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 0, gated.stderr);
  const [record] = ledgerOf(r.root, "T1").gates;
  assert.deepEqual([record.role, record.tier], ["verify", "full"]);
  assert.match(readFileSync(reported.brief, "utf8"), /recorded green on [0-9a-f]{7}/);
});

test("the verdict shows the gate runs already recorded on its tip", () => {
  const r = repo({ spec: VERIFY_GATES });
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1").json;
  assert.equal(lane(r, "gate", "T1").exit, 0);
  judge(out, "PASS");
  const judged = lane(r, "verdict", "T1");
  assert.equal(judged.json.next, "close");
  assert.equal(judged.json.gates, "1 green, 0 red on this tip");
});

const notesReport = (out, verdict = "PASS WITH NOTES") =>
  writeFileSync(
    out.reportPath,
    `Checked.\n\nNotes:\n- N1. copy says "colour" in one place\n- **N2**: the reset path skips the queue\nN3 - minor naming\nused_memories: none\nVerdict: ${verdict}\n`,
  );

test("fix <id> --notes sends the builder back on the named notes, then the usual recheck", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1", "--agent", "builder-1").json;
  notesReport(out);
  assert.equal(lane(r, "verdict", "T1", "--agent", "verifier-1").json.next, "gate");
  assert.equal(lane(r, "gate", "T1").json.next, "close");

  const fixed = lane(r, "fix", "T1", "--notes", "n2,N3");
  assert.equal(fixed.exit, 0, fixed.stderr);
  assert.equal(fixed.json.step, "fix");
  assert.equal(fixed.json.next, "fix");
  assert.equal(fixed.json.state, "fixing");
  assert.deepEqual(fixed.json.notes, ["N2", "N3"]);
  assert.equal(fixed.json.mode, "resume");
  assert.equal(fixed.json.agent, "builder-1");
  const brief = readFileSync(fixed.json.brief, "utf8");
  assert.match(brief, /## Notes to fix/);
  assert.match(brief, /- N2: the reset path skips the queue/);
  assert.match(brief, /- N3: minor naming/);
  assert.doesNotMatch(brief, /N1: copy says/);
  assert.doesNotMatch(brief, /Fix every FAIL item/);

  commitFile(fixed.json.worktree, "notes.txt", "fixed\n", "fix: address notes");
  writeFileSync(fixed.json.reportPath, "DONE\nfixed N2, N3\nused_memories: none\n");
  const rechecked = lane(r, "report", "T1");
  assert.equal(rechecked.json.next, "recheck");
  assert.equal(rechecked.json.agent, "verifier-1");
  const recheckBrief = readFileSync(rechecked.json.brief, "utf8");
  assert.match(recheckBrief, /## Notes sent back/);
  assert.match(recheckBrief, /- N2: the reset path skips the queue\n- N3: minor naming/);
  assert.doesNotMatch(recheckBrief, /N1: copy says/);
});

test("close keeps the build report's task line after a notes-fix round", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1", "--agent", "builder-1").json;
  notesReport(out);
  lane(r, "verdict", "T1", "--agent", "verifier-1");
  lane(r, "gate", "T1");
  const fixed = lane(r, "fix", "T1", "--notes", "N2").json;
  commitFile(fixed.worktree, "notes.txt", "fixed\n", "fix: address notes");
  writeFileSync(fixed.reportPath, "DONE\nfixed the queue note\nused_memories: none\n");
  const recheck = lane(r, "report", "T1").json;
  judge(recheck, "PASS");
  const rechecked = lane(r, "verdict", "T1");
  assert.equal(rechecked.exit, 0, rechecked.stderr);
  judge(rechecked.json, "PASS");
  const finalVerdict = lane(r, "verdict", "T1");
  assert.equal(finalVerdict.exit, 0, finalVerdict.stderr);
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 0, gated.stderr);
  const closed = lane(r, "close", "T1");
  assert.equal(closed.exit, 0, closed.stderr);
  assert.equal(closed.json.episode.task, "T1: added out.txt");
});

test("owns --set --apply during a notes-fix round keeps the brief's notes to fix", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1", "--agent", "builder-1").json;
  notesReport(out);
  lane(r, "verdict", "T1", "--agent", "verifier-1");
  lane(r, "gate", "T1");
  const fixed = lane(r, "fix", "T1", "--notes", "N2").json;
  const applied = lane(r, "owns", "T1", "--set", "src/other.gd", "--apply");
  assert.equal(applied.exit, 0, applied.stderr);
  const brief = readFileSync(fixed.brief, "utf8");
  assert.match(brief, /- `src\/other\.gd` \(new\)/);
  assert.match(brief, /## Notes to fix\n[\s\S]*- N2: the reset path skips the queue/);
  assert.doesNotMatch(brief, /N3: minor naming/);
});

test("fix stops at the notes-round budget, exit 2, and says what to do next", () => {
  // strict: three notes rounds, and a fresh final after each recheck.
  const r = repo({ spec: { ...SPEC, exec: { preset: "strict" } } });
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1", "--agent", "builder-1").json;
  notesReport(out);
  lane(r, "verdict", "T1", "--agent", "verifier-1");
  for (let i = 1; i <= 3; i++) {
    const fixed = lane(r, "fix", "T1", "--notes", "N2").json;
    commitFile(fixed.worktree, `n${i}.txt`, "x\n", `fix: round ${i}`);
    writeFileSync(fixed.reportPath, "DONE\nfixed\nused_memories: none\n");
    const recheck = lane(r, "report", "T1").json;
    notesReport(recheck);
    const final = lane(r, "verdict", "T1").json;
    notesReport(final);
    assert.match(lane(r, "verdict", "T1").json.next, /gate|close/);
  }
  const rounds = ledgerOf(r.root, "T1").rounds.length;
  const over = lane(r, "fix", "T1", "--notes", "N2");
  assert.equal(over.exit, 2);
  assert.match(
    over.stderr,
    /3 of 3 notes rounds are used \(exec\.noteRounds is 3; next is (gate|close)\) → .*exec (gate|close) T1/,
  );
  assert.equal(ledgerOf(r.root, "T1").rounds.length, rounds, "a refusal changes nothing");
});

test("fix is refused without notes, for a note the report lacks, and outside a PASS WITH NOTES lane", () => {
  const r = repo();
  assert.match(lane(r, "fix", "T1").stderr, /fix needs --notes N1,N3/);
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1").json;
  assert.match(lane(r, "fix", "T1", "--notes", "N1").stderr, /notes can be fixed only after/);
  notesReport(out, "PASS");
  lane(r, "verdict", "T1");
  assert.match(lane(r, "fix", "T1", "--notes", "N1").stderr, /notes can be fixed only after/);

  const q = repo();
  let two = lane(q, "start", "T1").json;
  build(two);
  two = lane(q, "report", "T1").json;
  notesReport(two);
  lane(q, "verdict", "T1");
  assert.match(lane(q, "fix", "T1", "--notes", "N9").stderr, /N9 not in the verifier's report/);
  assert.match(lane(q, "fix", "T1", "--notes", "first").stderr, /note labels, like N1,N3/);
  assert.equal(ledgerOf(q.root, "T1").rounds.length, 2, "a refusal changes nothing");
});

// ---- board writes and guard.allow -----------------------------------------------------------------

const BOARD = join(dirname(LANE), "board.mjs");
const boardCli = (root, ...args) =>
  spawnSync("node", [BOARD, ...args, "--root", root], { encoding: "utf8", env: gitEnv });
const WITH_CREATE = structuredClone(SPEC);
WITH_CREATE.kinds.decision.create = {
  id: "ask",
  rows: [{ in: "self", at: "end", cells: { "#": "{id}", Decision: "{decision}" } }],
};
const decisions = (root) => join(root, "plan", "DECISIONS.md");

test("board add and board set --apply in main while a lane builds do not stop it", () => {
  const r = repo({ spec: WITH_CREATE });
  build(lane(r, "start", "T1").json);
  const fields = '{"id": "3", "decision": "A night call"}';
  const add = boardCli(r.root, "add", "decision", "--fields", fields, "--apply");
  assert.equal(add.status, 0, add.stderr);
  const set = boardCli(r.root, "set", "decision", "D2", "decision=Cited after all", "--apply");
  assert.equal(set.status, 0, set.stderr);
  const sprint = boardCli(r.root, "set", "sprint", "S1", "status=done", "--apply");
  assert.equal(sprint.status, 0, sprint.stderr);
  const res = lane(r, "report", "T1");
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
});

test("a hand edit of an owned board file after a recorded board write still trips", () => {
  const r = repo({ spec: WITH_CREATE, tasks: OWNS_BOARD });
  build(lane(r, "start", "T1").json);
  const set = boardCli(r.root, "set", "decision", "D2", "decision=Cited", "--apply");
  assert.equal(set.status, 0, set.stderr);
  const file = decisions(r.root);
  writeFileSync(file, `${readFileSync(file, "utf8")}\nA builder's line.\n`);
  assert.match(tripped(lane(r, "report", "T1")), /files changed: {2}M plan\/DECISIONS\.md/);
});

test("a board preview, or a board write made in the lane's worktree, excuses nothing in an owned board file", () => {
  const r = repo({ spec: WITH_CREATE, tasks: OWNS_BOARD });
  const out = lane(r, "start", "T1").json;
  build(out);
  const preview = boardCli(r.root, "set", "decision", "D2", "decision=Cited");
  assert.equal(preview.status, 0, preview.stderr);
  const inTree = boardCli(out.worktree, "set", "decision", "D2", "decision=Cited", "--apply");
  assert.equal(inTree.status, 0, inTree.stderr);
  writeFileSync(decisions(r.root), readFileSync(decisions(out.worktree), "utf8"));
  assert.match(tripped(lane(r, "report", "T1")), /files changed: {2}M plan\/DECISIONS\.md/);
});

test("a board write recorded before the lane started excuses nothing in an owned board file during it", () => {
  const r = repo({ spec: WITH_CREATE, tasks: OWNS_BOARD });
  const file = decisions(r.root);
  const original = readFileSync(file, "utf8");
  assert.equal(boardCli(r.root, "set", "decision", "D2", "decision=X", "--apply").status, 0);
  writeFileSync(file, original); // back as committed: the recorded write's `from`
  build(lane(r, "start", "T1").json);
  writeFileSync(file, original.replace("Not cited", "X")); // the same edit, by hand
  assert.match(tripped(lane(r, "report", "T1")), /files changed: {2}M plan\/DECISIONS\.md/);
});

test("guard.allow lets main edits through, except in a running lane's owned files", () => {
  const spec = { ...SPEC, guard: { allow: ["docs/**", "src/ui/**", "two.txt"] } };
  const r = repo({ spec });
  commitFile(r.root, "docs/STATUS.md", "# Status\n");
  build(lane(r, "start", "T1").json);
  assert.equal(lane(r, "start", "T2").exit, 0);
  writeFileSync(join(r.root, "docs", "STATUS.md"), "# Status\n\nNight notes.\n");
  writeFileSync(join(r.root, "docs", "draft.md"), "a draft\n");
  const res = lane(r, "report", "T1");
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));

  const breaches = {
    "this lane's file": (root) => {
      mkdirSync(join(root, "src", "ui"), { recursive: true });
      writeFileSync(join(root, "src", "ui", "panel.css"), "x\n");
    },
    "another running lane's file": (root) => writeFileSync(join(root, "two.txt"), "x\n"),
    "a file no glob allows": (root) => writeFileSync(join(root, "stray.txt"), "x\n"),
  };
  for (const [what, act] of Object.entries(breaches)) {
    const r2 = repo({ spec });
    build(lane(r2, "start", "T1").json);
    assert.equal(lane(r2, "start", "T2").exit, 0, what);
    act(r2.root);
    assert.match(tripped(lane(r2, "report", "T1"), what), /main touched: files changed/, what);
  }
});

test("guard.allow lets nothing through while a running lane's owned files cannot be read", () => {
  const r = repo({ spec: { ...SPEC, guard: { allow: ["docs/**"] } } });
  build(lane(r, "start", "T1").json);
  writeFileSync(
    ledgerFile(r.root, "ZZ"),
    JSON.stringify({ v: 1, id: "ZZ", state: "merging", worktree: "/gone" }),
  );
  mkdirSync(join(r.root, "docs"));
  writeFileSync(join(r.root, "docs", "STATUS.md"), "x\n");
  assert.match(tripped(lane(r, "report", "T1")), /docs\/STATUS\.md/);
});

test("a staged rename never carries an owned file past guard.allow, and a lone rename does not crash", () => {
  const spec = { ...SPEC, guard: { allow: ["**/*.md", "two.txt"] } };
  const breaches = {
    "an owned file renamed into an allowed path": (root) =>
      git(root, "mv", "two.txt", "docs/two.md"),
    "an owned file edited beside an allowed rename": (root) => {
      writeFileSync(join(root, "two.txt"), "edited\n");
      git(root, "mv", "docs/A.md", "docs/C.md");
    },
  };
  for (const [what, act] of Object.entries(breaches)) {
    const r = repo({ spec });
    commitFile(r.root, "two.txt", "two\n");
    commitFile(r.root, "docs/A.md", "# A\n");
    build(lane(r, "start", "T1").json);
    assert.equal(lane(r, "start", "T2").exit, 0, what);
    act(r.root);
    assert.match(tripped(lane(r, "report", "T1"), what), /main touched: files changed/, what);
  }
  const r = repo({ spec });
  commitFile(r.root, "docs/A.md", "# A\n");
  build(lane(r, "start", "T1").json);
  git(r.root, "mv", "docs/A.md", "docs/Z.md");
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
});

// ---- decisions made after the contract, and a section the conductor appended -----------------------

const LATER_DECISIONS = `${DECISIONS_MD}| 3 | Pick option A (T1 may go ahead) |
| 4 | Unrelated, mentions T10 only |
| 5 | Chosen by the owner later |
`;

test("a brief quotes a decision whose row names the task, though the contract never cites it", () => {
  const r = repo({ decisions: LATER_DECISIONS });
  const brief = readFileSync(lane(r, "start", "T1").json.brief, "utf8");
  assert.match(brief, /- D1: \| 1 \| Plain files \|/);
  assert.match(brief, /- D3: \| 3 \| Pick option A \(T1 may go ahead\) \|/);
  assert.doesNotMatch(brief, /T10 only/);
  assert.doesNotMatch(brief, /Not cited/);
});

test("start --cite adds decisions by id to every brief, and refuses an id the board lacks", () => {
  const r = repo({ decisions: LATER_DECISIONS });
  const bad = lane(r, "start", "T1", "--cite", "D5,D99");
  assert.equal(bad.exit, 2);
  assert.match(bad.stderr, /--cite names no decision on the board: D99/);
  assert.equal(existsSync(join(r.root, ".agentry", "run", "worktrees", "T1")), false);
  const out = lane(r, "start", "T1", "--cite", "d5").json;
  assert.match(readFileSync(out.brief, "utf8"), /- D5: \| 5 \| Chosen by the owner later \|/);
  build(out);
  const verify = lane(r, "report", "T1").json;
  assert.match(readFileSync(verify.brief, "utf8"), /- D5: /);
  assert.match(lane(r, "show", "T1", "--cite", "D5").stderr, /show takes no --cite/);
});

test("owns --apply keeps a section appended after the brief's last template section", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  const fact = "\n## The fact\n\nThe clock is injected, not read.\n";
  writeFileSync(out.brief, readFileSync(out.brief, "utf8") + fact);
  assert.equal(lane(r, "owns", "T1", "--set", "a.ts", "--apply").exit, 0);
  const brief = readFileSync(out.brief, "utf8");
  assert.match(brief, /- `a\.ts` \(new\)/);
  assert.ok(brief.endsWith(fact), "the appended section is still last");
  // A second rewrite does not duplicate it.
  assert.equal(lane(r, "owns", "T1", "--set", "b.ts", "--apply").exit, 0);
  assert.equal(readFileSync(out.brief, "utf8").split("## The fact").length, 2);
});

// ---- idle lanes, commits guard.allow lets through, a red gate after a green -------------------------

// The lane's branch commit, every file in its worktree and its round's dispatch, made `minutes` ago.
function age(worktree, minutes, root) {
  const when = new Date(Date.now() - minutes * 60_000);
  const file = ledgerFile(root, basename(worktree));
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  ledger.rounds.at(-1).at = when.toISOString();
  writeFileSync(file, JSON.stringify(ledger, null, 2));
  const env = {
    ...gitEnv,
    GIT_AUTHOR_DATE: when.toISOString(),
    GIT_COMMITTER_DATE: when.toISOString(),
  };
  writeFileSync(join(worktree, "out.txt"), "made\n");
  spawnSync("git", ["-C", worktree, "add", "out.txt"], { env });
  spawnSync("git", ["-C", worktree, "commit", "-qm", "feat: add out.txt"], { env });
  const files = git(worktree, "ls-files", "-z", "--cached", "--others", "--exclude-standard");
  for (const file of files.split("\0").filter(Boolean))
    utimesSync(join(worktree, file), when, when);
}
const textOf = (r, ...args) =>
  spawnSync("node", [LANE, "exec", ...args, "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home },
  }).stdout;

test("idle.test: a building lane with nothing changed for 25 minutes prints the idle line; 15 minutes and a held lane print none", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  age(out.worktree, 25, r.root);
  const shown = lane(r, "show", "T1").json;
  assert.ok(shown.idle.minutes >= 25 && shown.idle.minutes < 30, JSON.stringify(shown.idle));
  assert.match(shown.idle.lastChange, /^\d{4}-\d\d-\d\dT/);
  const lines = textOf(r, "show", "T1").split("\n");
  assert.equal(lines[0], "T1 · show → build (building)");
  assert.match(
    lines[1],
    /^idle: T1 2\dm: last change \d\d:\d\d \(.+\) → check the builder; .*exec hold T1 --root .* --for later to park it$/,
  );
  const started = spawnSync("node", [LANE, "session", "start", "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home },
  }).stdout;
  // The session prints the park step on its own line, so 80 columns never cut it.
  assert.match(
    started,
    /^idle: T1 2\dm: last change \d\d:\d\d \(.+\) → check the builder\n {2}→ (agentry )?lane exec hold T1 --for later to park it$/m,
  );

  const fresh = repo();
  age(lane(fresh, "start", "T1").json.worktree, 15, fresh.root);
  assert.equal(lane(fresh, "show", "T1").json.idle, undefined);

  // A builder just sent is not idle, however old the worktree: the round's dispatch counts as a change.
  const sent = repo();
  const wt = lane(sent, "start", "T1").json.worktree;
  age(wt, 25, sent.root);
  const ledger = JSON.parse(readFileSync(ledgerFile(sent.root, "T1"), "utf8"));
  ledger.rounds.at(-1).at = new Date().toISOString();
  writeFileSync(ledgerFile(sent.root, "T1"), JSON.stringify(ledger, null, 2));
  assert.equal(lane(sent, "show", "T1").json.idle, undefined);

  writeFileSync(out.reportPath, "DONE\nsee it\n");
  assert.equal(lane(r, "hold", "T1", "--for", "owner").exit, 0);
  assert.equal(lane(r, "show", "T1").json.idle, undefined);
});

test("a hand commit on main touching only a guard.allow path passes the report; so does another path, an owned one trips", () => {
  const spec = { ...SPEC, guard: { allow: ["docs/**", "src/ui/**"] } };
  const r = repo({ spec });
  const out = lane(r, "start", "T1").json;
  const sha = commitFile(r.root, "docs/STATUS.md", "# Status\n", "docs: status");
  build(out);
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "verify");
  assert.deepEqual(res.json.guards, [`main moved by allowed commits: 1 (${sha.slice(0, 7)})`]);

  const other = repo({ spec });
  const o1 = lane(other, "start", "T1").json;
  commitFile(other.root, "docs/STATUS.md", "# Status\n", "docs: status");
  commitFile(other.root, "stray.txt", "x\n", "chore: stray.txt");
  build(o1);
  const passed = lane(other, "report", "T1");
  assert.equal(passed.json.next, "verify", JSON.stringify(passed.json.guards));
  assert.match(passed.json.guards[0], /^main moved by allowed commits: 2 /);

  const r2 = repo({ spec });
  const o2 = lane(r2, "start", "T1").json;
  commitFile(r2.root, "docs/STATUS.md", "# Status\n", "docs: status");
  const owned = commitFile(r2.root, "src/ui/panel.css", "x\n", "chore: src/ui/panel.css");
  build(o2);
  const trip = tripped(lane(r2, "report", "T1"));
  assert.match(trip, /main touched: HEAD moved [0-9a-f]{7} → [0-9a-f]{7} \(/);
  assert.ok(
    trip.includes(`(${owned.slice(0, 7)} touches src/ui/panel.css, this lane's files)`),
    trip,
  );
});

// ---- Agentry's config is always allowed (field 58) ---------------------------------------------------

// The process and workflow files rewritten (the same spec, compact), uncommitted.
function editConfig(dir) {
  for (const name of ["process.json", "workflow.json"]) {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8"))));
  }
}
function commitConfig(root, dir = ".agentry") {
  editConfig(join(root, dir));
  git(root, "add", dir);
  git(root, "commit", "-q", "-m", "chore: tune the process");
  return git(root, "rev-parse", "HEAD");
}

test("a commit on main of both config files passes a building lane and a parked one, with no guard.allow", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out);
  const t2 = lane(r, "start", "T2").json;
  writeFileSync(join(t2.worktree, "two.txt"), "half\n");
  assert.equal(lane(r, "hold", "T2", "--for", "later").exit, 0);
  const sha = commitConfig(r.root);
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "verify");
  assert.deepEqual(res.json.guards, [`main moved by allowed commits: 1 (${sha.slice(0, 7)})`]);
  const resumed = lane(r, "resume", "T2", "--note", "back");
  assert.equal(resumed.exit, 0, resumed.stderr);
  assert.equal(resumed.json.next, "continue");
});

test("uncommitted edits of both config files pass the report", () => {
  const r = repo();
  build(lane(r, "start", "T1").json);
  editConfig(join(r.root, ".agentry"));
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
  assert.deepEqual(res.json.guards, []);
});

test("a commit of the workflow file and an owned path still trips, naming only the owned one", () => {
  const r = repo({ spec: { ...SPEC, guard: { allow: ["docs/**"] } } });
  build(lane(r, "start", "T1").json);
  editConfig(join(r.root, ".agentry"));
  writeFileSync(join(r.root, "out.txt"), "x\n");
  git(r.root, "add", ".agentry/workflow.json", "out.txt");
  git(r.root, "commit", "-q", "-m", "chore: workflow and an owned file");
  git(r.root, "checkout", "-q", "--", ".agentry/process.json");
  assert.match(
    tripped(lane(r, "report", "T1")),
    /main touched: HEAD moved [0-9a-f]{7} → [0-9a-f]{7} \([0-9a-f]{7} touches out\.txt, this lane's files\)$/,
  );
});

test("a running lane that owns the workflow file trips on it, committed or not; the other lane does not on the commit", () => {
  const tasks = `${TASKS_MD}- **T3** (S1): owns \`.agentry/workflow.json\`. Accept: it changed.\n`;
  const board = (root) =>
    writeFileSync(
      join(root, "plan", "BOARD.md"),
      readFileSync(join(root, "plan", "BOARD.md"), "utf8").replace(
        "| T2   | S1     | todo   |         |        |\n",
        "| T2   | S1     | todo   |         |        |\n| T3   | S1     | todo   |         |        |\n",
      ),
    );
  const setup = () => {
    const r = repo({ tasks });
    board(r.root);
    git(r.root, "commit", "-qam", "docs: add T3");
    build(lane(r, "start", "T1").json);
    assert.equal(lane(r, "start", "T3").exit, 0);
    return r;
  };
  const committed = setup();
  const pre = git(committed.root, "rev-parse", "HEAD");
  editConfig(join(committed.root, ".agentry"));
  git(committed.root, "add", ".agentry/workflow.json");
  git(committed.root, "commit", "-q", "-m", "chore: workflow");
  const sha = git(committed.root, "rev-parse", "HEAD");
  git(committed.root, "checkout", "-q", "--", ".agentry/process.json");
  const t1 = lane(committed, "report", "T1");
  assert.equal(t1.json.next, "verify", JSON.stringify(t1.json.guards));
  assert.deepEqual(t1.json.guards, [`main moved by allowed commits: 1 (${sha.slice(0, 7)})`]);
  const t3 = lane(committed, "hold", "T3", "--for", "later");
  assert.equal(t3.exit, 0, t3.stderr);
  assert.equal(
    t3.json["main moved while parked"],
    `HEAD moved ${pre.slice(0, 7)} → ${sha.slice(0, 7)} (${sha.slice(0, 7)} touches .agentry/workflow.json, this lane's files); resume re-checks it`,
  );

  const edited = setup();
  editConfig(join(edited.root, ".agentry"));
  git(edited.root, "checkout", "-q", "--", ".agentry/process.json");
  assert.match(
    tripped(lane(edited, "report", "T1")),
    /main touched: files changed: {2}M \.agentry\/workflow\.json$/,
  );
});

test("the config files allowed are the ones in use: --process's and its sibling, not .agentry's", () => {
  const r = repo();
  writeSpec(join(r.root, "cfg"), SPEC);
  git(r.root, "add", "cfg");
  git(r.root, "commit", "-q", "-m", "chore: process files in cfg");
  const at = (...args) => lane(r, ...args, "--process", join(r.root, "cfg", "process.json"));
  build(at("start", "T1").json);
  const sha = commitConfig(r.root, "cfg");
  const res = at("report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual(res.json.guards, [`main moved by allowed commits: 1 (${sha.slice(0, 7)})`]);

  const r2 = repo();
  writeSpec(join(r2.root, "cfg"), SPEC);
  git(r2.root, "add", "cfg");
  git(r2.root, "commit", "-q", "-m", "chore: process files in cfg");
  const at2 = (...args) => lane(r2, ...args, "--process", join(r2.root, "cfg", "process.json"));
  build(at2("start", "T1").json);
  editConfig(join(r2.root, ".agentry"));
  assert.match(
    tripped(at2("report", "T1")),
    /main touched: files changed: {2}M \.agentry\/process\.json, {2}M \.agentry\/workflow\.json$/,
  );
});

test("a green then a red gate on one tip says the latest is red, and the waiting verify brief runs the gate", () => {
  const spec = {
    ...SPEC,
    gate: {
      tiers: [{ name: "full", command: ["sh", "-c", 'test ! -f "$HOME/red"'] }],
      roles: { verify: "pick" },
    },
  };
  const r = repo({ spec });
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1").json;
  assert.equal(out.next, "verify");
  const green = lane(r, "gate", "T1");
  assert.equal(green.exit, 0);
  assert.match(
    readFileSync(out.brief, "utf8"),
    /recorded green on [0-9a-f]{7} .*: read it; do not re-run it/,
  );
  writeFileSync(join(r.home, "red"), "");
  const red = lane(r, "gate", "T1");
  assert.equal(red.exit, 1);
  assert.equal(red.json.gates, "1 green, then 1 red on this tip: the latest is red");
  assert.equal(red.json.briefUpdated, out.brief);
  const brief = readFileSync(out.brief, "utf8");
  assert.doesNotMatch(brief, /do not re-run it/);
  assert.match(
    brief,
    /Run the gate as the lane records it, in the foreground.*\n?.*exec gate T1 --root/,
  );
});

// ---- config edits can't widen the guard (R1d-21 N3); R1d-21's probes P1, P7 and P8 ---------------------

// The workflow file in `.agentry/` with `change` made to its parsed value, left uncommitted.
function editWorkflow(root, change) {
  const file = join(root, ".agentry", "workflow.json");
  const value = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, `${JSON.stringify(change(value), null, 2)}\n`);
}

// ---- one overlap rule for committed main moves (field 81) and Agentry's own files (field 78) ----------

test("a builder's own commit made in the main checkout (wrong cwd) touches its owned files and trips", () => {
  const r = repo();
  const out = lane(r, "start", "T1");
  const sha = commitFile(r.root, "out.txt", "made\n", "feat: add out.txt");
  writeFileSync(out.json.reportPath, "DONE\nadded out.txt\nused_memories: none\n");
  assert.ok(
    tripped(lane(r, "report", "T1")).endsWith(
      `(${sha.slice(0, 7)} touches out.txt, this lane's files)`,
    ),
  );
});

test("removing a one-off guard.allow entry never re-trips a lane: the commit touched none of its files", () => {
  const r = repo({ spec: { ...SPEC, guard: { allow: ["docs/**"] } } });
  const out = lane(r, "start", "T1").json;
  commitFile(r.root, "docs/STATUS.md", "# Status\n", "docs: status");
  build(out);
  writeFileSync(join(out.worktree, "left.txt"), "x\n"); // a builder's leftover: a fix round
  const first = lane(r, "report", "T1");
  assert.equal(first.json.next, "fix", JSON.stringify(first.json.guards));
  editWorkflow(r.root, ({ guard, ...w }) => w);
  git(r.root, "commit", "-qam", "chore: drop the one-off allow");
  rmSync(join(out.worktree, "left.txt"));
  writeFileSync(first.json.reportPath, "DONE\nremoved it\nused_memories: none\n");
  const second = lane(r, "report", "T1");
  assert.equal(second.json.next, "verify", JSON.stringify(second.json.guards));
  assert.match(second.json.guards.at(-1), /^main moved by allowed commits: 2 /);
});

test(".agentry/config.json passes the guard, uncommitted or committed, a guard key in it included (field 78)", () => {
  const r = repo();
  writeFileSync(join(r.root, ".gitignore"), ".agentry/run/\n");
  const config = join(r.root, ".agentry", "config.json");
  writeFileSync(config, `${JSON.stringify({ lanes: { maxWriters: 3 } })}\n`);
  git(r.root, "add", ".gitignore", ".agentry/config.json");
  git(r.root, "commit", "-q", "-m", "chore: track the config");
  build(lane(r, "start", "T1").json);
  writeFileSync(
    config,
    `${JSON.stringify({ lanes: { maxWriters: 2 }, guard: { allow: ["**"] } })}\n`,
  );
  const edited = lane(r, "report", "T1");
  assert.equal(edited.json.next, "verify", JSON.stringify(edited.json.guards));
  assert.deepEqual(edited.json.guards, []);

  const r2 = repo();
  build(lane(r2, "start", "T1").json);
  writeFileSync(join(r2.root, ".gitignore"), ".agentry/run/\n");
  writeFileSync(join(r2.root, ".agentry", "config.json"), "{}\n");
  git(r2.root, "add", ".agentry/config.json");
  git(r2.root, "commit", "-q", "-m", "chore: add the config");
  git(r2.root, "checkout", "-q", "--", ".gitignore");
  const committed = lane(r2, "report", "T1");
  assert.equal(committed.json.next, "verify", JSON.stringify(committed.json.guards));
  assert.match(committed.json.guards[0], /^main moved by allowed commits: 1 /);
});

test("an uncommitted config edit that changes the guard or gate key trips; other edits keep passing", () => {
  const trips = {
    guard: (w) => ({ ...w, guard: { allow: ["**"] } }),
    gate: (w) => ({ ...w, gate: { tiers: [{ name: "full", command: ["true"] }] } }),
  };
  for (const [key, change] of Object.entries(trips)) {
    const r = repo();
    build(lane(r, "start", "T1").json);
    editWorkflow(r.root, change);
    assert.equal(
      tripped(lane(r, "report", "T1"), key),
      `main touched: .agentry/workflow.json changes ${key} while lanes run → commit it between lanes`,
      key,
    );
  }
  for (const [why, change] of Object.entries({
    "a re-indented file": (w) => w,
    "another key": (w) => ({ ...w, models: { build: "sonnet" } }),
  })) {
    const r = repo();
    build(lane(r, "start", "T1").json);
    editWorkflow(r.root, change);
    const res = lane(r, "report", "T1");
    assert.equal(res.exit, 0, `${why}: ${res.json?.reason}`);
    assert.deepEqual(res.json.guards, [], why);
  }
});

test("a committed config change of the guard key keeps passing (R1d-21)", () => {
  const r = repo();
  build(lane(r, "start", "T1").json);
  editWorkflow(r.root, (w) => ({ ...w, guard: { allow: ["notes/**"] } }));
  git(r.root, "add", ".agentry/workflow.json");
  git(r.root, "commit", "-q", "-m", "chore: allow notes");
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.json?.reason);
  assert.match(res.json.guards[0], /^main moved by allowed commits: 1 /);
});

test("P1: a building lane and a parked one both pass the guard on their next report after a config commit", () => {
  const r = repo();
  build(lane(r, "start", "T1").json);
  const t2 = lane(r, "start", "T2").json;
  writeFileSync(join(t2.worktree, "two.txt"), "half\n");
  assert.equal(lane(r, "hold", "T2", "--for", "later").exit, 0);
  const sha = commitConfig(r.root).slice(0, 7);
  const line = [`main moved by allowed commits: 1 (${sha})`];
  assert.deepEqual(lane(r, "report", "T1").json.guards, line);
  const resumed = lane(r, "resume", "T2", "--note", "back").json;
  git(t2.worktree, "add", "two.txt");
  git(t2.worktree, "commit", "-q", "-m", "feat: two");
  writeFileSync(resumed.reportPath, "DONE\nadded two.txt\nused_memories: none\n");
  const rep = lane(r, "report", "T2");
  assert.equal(rep.exit, 0, rep.stderr);
  assert.deepEqual(rep.json.guards, line);
});

test("P7: the idle nudge on a tripped main names the park step, and the park exits 0", () => {
  const r = repo();
  const t1 = lane(r, "start", "T1").json;
  writeFileSync(join(t1.worktree, "out.txt"), "half\n");
  const file = join(r.root, ".agentry", "run", "process", "ledger", "T1.json");
  const l = JSON.parse(readFileSync(file, "utf8"));
  const old = new Date(Date.now() - 60 * 60_000);
  l.rounds.at(-1).at = old.toISOString();
  writeFileSync(file, JSON.stringify(l, null, 2));
  spawnSync("git", ["-C", t1.worktree, "commit", "-q", "--amend", "--no-edit", "--allow-empty"], {
    env: { ...gitEnv, GIT_COMMITTER_DATE: old.toISOString(), GIT_AUTHOR_DATE: old.toISOString() },
  });
  for (const f of git(t1.worktree, "ls-files", "--cached", "--others", "--exclude-standard").split(
    "\n",
  ))
    if (f) utimesSync(join(t1.worktree, f), old, old);
  commitFile(r.root, "out.txt", "x\n", "chore: by hand"); // trips T1: its owned file
  const session = spawnSync("node", [LANE, "session", "start", "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home, NO_COLOR: "1" },
  });
  assert.ok(
    session.stdout.split("\n").some((x) => /exec hold T1 --for later/.test(x)),
    session.stdout,
  );
  const park = lane(r, "hold", "T1", "--for", "later");
  assert.equal(park.exit, 0, park.stderr);
  assert.match(park.json["main moved while parked"], /HEAD moved/);
});

test("P8: with .agentry/run not gitignored the run files stay Agentry's own, and a config commit passes", () => {
  const r = repo();
  writeFileSync(join(r.root, ".gitignore"), ".agentry/config.json\n");
  git(r.root, "commit", "-qam", "chore: no run ignore");
  build(lane(r, "start", "T1").json);
  editConfig(join(r.root, ".agentry"));
  // Only the two config files: the run files beside them are untracked, and stay so.
  git(r.root, "add", ".agentry/process.json", ".agentry/workflow.json");
  git(r.root, "commit", "-q", "-m", "chore: tune");
  const sha = git(r.root, "rev-parse", "--short=7", "HEAD");
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.json?.reason);
  assert.deepEqual(res.json.guards, [`main moved by allowed commits: 1 (${sha})`]);
});

// ---- hold: the owner's gate, the evidence (R1d-6 N9, final N3) ------------------------------------------

const STEPS_MD = `# Tasks

### T1 · Two steps

- **Owns:** \`out.txt\`, \`two.txt\`
- **Steps:**
  1. Write out.txt → owner OK
  2. Write two.txt
- **Acceptance:**
  - Step 1: out.txt exists
  - two.txt exists

### T2 · Other

- **Owns:** \`two.txt\`. Accept: two.txt exists.
`;

test("a park on a lane held for the owner after a step is refused, nothing written; a during hold still parks", () => {
  const r = repo({ tasks: STEPS_MD });
  build(lane(r, "start", "T1").json);
  assert.equal(lane(r, "report", "T1").json.state, "held");
  const before = readFileSync(
    join(r.root, ".agentry", "run", "process", "ledger", "T1.json"),
    "utf8",
  );
  const res = lane(r, "hold", "T1", "--for", "later");
  assert.equal(res.exit, 2);
  assert.match(
    res.stderr,
    /T1 waits for the owner after step 1: resume it with the owner's words \(exec resume T1 --note "…"\), or keep it held/,
  );
  assert.equal(
    readFileSync(join(r.root, ".agentry", "run", "process", "ledger", "T1.json"), "utf8"),
    before,
  );
  const other = repo();
  const t1 = lane(other, "start", "T1").json;
  build(t1);
  assert.equal(lane(other, "hold", "T1", "--for", "owner").exit, 0);
  assert.equal(lane(other, "hold", "T1", "--for", "later").exit, 0, "a during hold may be parked");
});

test("a hold's evidence must be a file: a directory or a missing path is refused", () => {
  const r = repo();
  const t1 = lane(r, "start", "T1").json;
  build(t1);
  mkdirSync(join(r.root, "shots"));
  for (const given of ["shots", "nope.png"]) {
    const res = lane(r, "hold", "T1", "--for", "owner", "--evidence", given);
    assert.equal(res.exit, 2, given);
    assert.match(
      res.stderr,
      new RegExp(
        `no file at ${given.replace(".", "\\.")}: save the builder's reply there first, or pass --evidence`,
      ),
    );
  }
  assert.equal(lane(r, "hold", "T1", "--for", "owner", "--evidence", t1.reportPath).exit, 0);
});

// ---- a recorded green is read only for the tier's current argv (R1d-12 gate notes) ---------------------

test("a green record whose argv is not the tier's current one is not read as the recorded gate", () => {
  const r = repo({ spec: VERIFY_GATES });
  build(lane(r, "start", "T1").json);
  const built = lane(r, "report", "T1").json;
  assert.equal(lane(r, "gate", "T1").exit, 0);
  assert.match(readFileSync(built.brief, "utf8"), /recorded green on/);
  // The owner commits another gate command on main (a committed config change passes the guard).
  editWorkflow(r.root, (w) => ({
    ...w,
    gate: {
      ...w.gate,
      tiers: [{ name: "full", command: ["sh", "-c", "test -f out.txt && true"] }],
    },
  }));
  git(r.root, "add", ".agentry/workflow.json");
  git(r.root, "commit", "-q", "-m", "chore: change the gate command");
  // Rewriting the waiting brief reads the gate records again.
  assert.equal(lane(r, "owns", "T1", "--set", "out.txt,src/ui/panel.css", "--apply").exit, 0);
  const text = readFileSync(built.brief, "utf8");
  assert.doesNotMatch(text, /recorded green on/);
  assert.match(text, /Run the gate as the lane records it/);
});

// ---- board files never trip a lane; a guard trip holds it; a stopped lane's ways on (field 75) -------

// The process file naming every kind of board location: a sprint's own file, a create block's file and
// a status note, beside the tables and the contract blocks.
const BOARD_FILES = structuredClone(SPEC);
BOARD_FILES.kinds.sprint.file = { glob: "sprints/{id}_*.md" };
BOARD_FILES.kinds.decision.create = {
  id: "ask",
  blocks: [{ file: "LOG.md", under: "Log", text: "- {id}" }],
};
BOARD_FILES.status = { note: "NOTE.md" };
function boardRepo({ tracked = true } = {}) {
  const r = tracked ? repo({ spec: BOARD_FILES }) : untrackedRepo(BOARD_FILES);
  commitFile(r.root, "plan/sprints/S1_first.md", "# S1\n");
  commitFile(r.root, "plan/LOG.md", "# Log\n");
  commitFile(r.root, "NOTE.md", "# Note\n");
  return r;
}
// A repo that keeps `.agentry/` out of git (an init choice), its board tracked: the process files are on
// disk only.
function untrackedRepo(spec) {
  const root = temp("exec-untracked-");
  const home = temp("exec-home-");
  git(root, "init", "-q", "-b", "main");
  commitFile(root, ".gitignore", ".agentry/\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  commitFile(root, "plan/DECISIONS.md", DECISIONS_MD);
  writeSpec(join(root, ".agentry"), spec);
  return { root, home };
}
const append = (root, file, line) =>
  writeFileSync(join(root, file), `${readFileSync(join(root, file), "utf8")}${line}\n`);

test("a hand commit of BOARD.md and a sprint file on main passes the next report with the allowed-commits line", () => {
  const r = boardRepo();
  const out = lane(r, "start", "T1").json;
  build(out);
  append(r.root, "plan/BOARD.md", "\nA line on the board.");
  append(r.root, "plan/sprints/S1_first.md", "Handoff written.");
  git(r.root, "add", "plan/BOARD.md", "plan/sprints/S1_first.md");
  git(r.root, "commit", "-q", "-m", "docs(board): by hand");
  const sha = git(r.root, "rev-parse", "HEAD").slice(0, 7);
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
  assert.deepEqual(res.json.guards, [`main moved by allowed commits: 1 (${sha})`]);
});

test("every board location the process file names may change uncommitted while a lane builds", () => {
  const r = boardRepo();
  build(lane(r, "start", "T1").json);
  for (const file of [
    "plan/BOARD.md",
    "plan/DECISIONS.md",
    "plan/TASKS.md",
    "plan/sprints/S1_first.md",
    "plan/LOG.md",
    "NOTE.md",
  ])
    append(r.root, file, "A hand edit.");
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
  assert.deepEqual(res.json.guards, []);
});

test("a files-kind item's file is a board file: a hand edit of another story passes", () => {
  const r = { root: temp("exec-files-"), home: temp("exec-home-") };
  git(r.root, "init", "-q", "-b", "main");
  commitFile(r.root, ".gitignore", ".agentry/run/\n");
  commitFile(r.root, "stories/s1.md", "---\nid: S-1\nstate: open\n---\n\n# One\n");
  commitFile(r.root, "stories/s2.md", "---\nid: S-2\nstate: open\n---\n\n# Two\n");
  commitFile(r.root, "TASKS.md", "# Tasks\n\n- **S-1**: owns `a.txt`.\n- **S-2**: owns `b.txt`.\n");
  commitSpec(r.root, STORIES);
  build(lane(r, "start", "S-1").json, "a.txt");
  append(r.root, "stories/s2.md", "A note by hand.");
  const res = lane(r, "report", "S-1");
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
});

// The process file in `.agentry/` with `change` made to its parsed value, left uncommitted.
function editProcess(root, change) {
  const file = join(root, ".agentry", "process.json");
  writeFileSync(
    file,
    `${JSON.stringify(change(JSON.parse(readFileSync(file, "utf8"))), null, 2)}\n`,
  );
}

// R1d-29 F1 (the verifier's P1): an uncommitted process file edit naming a code file as a board location
// never lets a main edit of that file through: the board is read as main's HEAD commits it.
for (const [how, change] of Object.entries({
  "status.note": (p) => ({ ...p, status: { note: "src/app.js" } }),
  "a new kind's table": (p) => ({
    ...p,
    kinds: {
      ...p.kinds,
      x: { label: "X", at: { table: "../src/app.js", heading: "X" }, id: { column: "X" } },
    },
  }),
  "contract.blocks": (p) => ({
    ...p,
    kinds: {
      ...p.kinds,
      task: { ...p.kinds.task, contract: { blocks: ["TASKS.md", "../src/app.js"] } },
    },
  }),
}))
  for (const tracked of [true, false])
    test(`a process file ${tracked ? "edited uncommitted" : "untracked, edited after start,"} naming src/app.js through ${how} lets no main edit of it through`, () => {
      const r = boardRepo({ tracked });
      commitFile(r.root, "src/app.js", "safe\n");
      build(lane(r, "start", "T1").json);
      editProcess(r.root, change);
      writeFileSync(join(r.root, "src", "app.js"), "EVIL\n");
      assert.match(tripped(lane(r, "report", "T1"), how), /files changed: {2}M src\/app\.js/, how);
    });

// R1d-29 F2a (the verifier's R4-P8, R4-P8b): with `.agentry/` out of git, the board paths come from the
// spec as `start` loaded it (`boardAtStart`).
test("with .agentry/ untracked, a hand commit of BOARD.md and a sprint file passes the report", () => {
  const r = boardRepo({ tracked: false });
  build(lane(r, "start", "T1").json);
  append(r.root, "plan/BOARD.md", "\nBy hand.");
  append(r.root, "plan/sprints/S1_first.md", "Handoff.");
  git(r.root, "add", "plan/BOARD.md", "plan/sprints/S1_first.md");
  git(r.root, "commit", "-q", "-m", "docs(board): by hand");
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
  assert.match(res.json.guards[0], /^main moved by allowed commits: 1 /);
});

test("with .agentry/ untracked, an uncommitted BOARD.md edit passes the report", () => {
  const r = boardRepo({ tracked: false });
  build(lane(r, "start", "T1").json);
  append(r.root, "plan/BOARD.md", "\nBy hand.");
  const res = lane(r, "report", "T1");
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
  assert.deepEqual(res.json.guards, []);
});

test("with .agentry/ untracked, a ledger from before boardAtStart lets no board file through", () => {
  const r = boardRepo({ tracked: false });
  build(lane(r, "start", "T1").json);
  const file = ledgerFile(r.root, "T1");
  const { boardAtStart, ...older } = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(boardAtStart.paths.includes("plan/BOARD.md"), JSON.stringify(boardAtStart));
  writeFileSync(file, JSON.stringify(older, null, 2));
  append(r.root, "plan/DECISIONS.md", "By hand.");
  assert.match(tripped(lane(r, "report", "T1")), /files changed: {2}M plan\/DECISIONS\.md/);
});

test("a sprint's own file made or removed by a hand commit passes: the kinds' globs are board paths (N1)", () => {
  const r = boardRepo();
  build(lane(r, "start", "T1").json);
  git(r.root, "rm", "-q", "plan/sprints/S1_first.md");
  git(r.root, "commit", "-q", "-m", "docs: archive the sprint");
  commitFile(r.root, "plan/sprints/S9_next.md", "# S9\n", "docs: a sprint with no row yet");
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
  assert.match(res.json.guards[0], /^main moved by allowed commits: 2 /);
});

// R1d-29 F2b (the verifier's R4-P10): a board path is kept when it stays inside the repository, as the
// spec's own check and `read.mjs` take it, though it goes up from the board root.
test("a committed contract block ../docs/TASKS.md is a board file: a hand edit of it passes", () => {
  const spec = structuredClone(BOARD_FILES);
  spec.kinds.task.contract.blocks = ["TASKS.md", "../docs/TASKS.md"];
  const r = repo({ spec });
  commitFile(r.root, "docs/TASKS.md", "# More tasks\n");
  build(lane(r, "start", "T1").json);
  append(r.root, "docs/TASKS.md", "By hand.");
  const res = lane(r, "report", "T1");
  assert.equal(res.json.next, "verify", JSON.stringify(res.json.guards));
});

test("an item id never names a board file: a sprint row ../../src/x leaves src/x_a.md guarded (N3)", () => {
  const r = boardRepo();
  commitFile(
    r.root,
    "plan/BOARD.md",
    board(r.root).replace("| S1     | doing  |", "| S1     | doing  |\n| ../../src/x | doing |"),
    "docs: a row",
  );
  commitFile(r.root, "src/x_a.md", "safe\n");
  build(lane(r, "start", "T1").json);
  writeFileSync(join(r.root, "src", "x_a.md"), "EVIL\n");
  assert.equal(tripped(lane(r, "report", "T1")), "main touched: files changed:  M src/x_a.md");
});

test("hold --for owner on a lane held for the guard is refused, the ledger as it was (N2)", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out);
  writeFileSync(join(r.root, "stray.txt"), "x\n");
  tripped(lane(r, "report", "T1"));
  const before = readFileSync(ledgerFile(r.root, "T1"), "utf8");
  const owner = lane(r, "hold", "T1", "--for", "owner", "--evidence", out.reportPath);
  assert.equal(owner.exit, 2);
  assert.match(
    owner.stderr,
    /the lane is held for the guard: fix it and run .*exec report T1 --root /,
  );
  assert.equal(readFileSync(ledgerFile(r.root, "T1"), "utf8"), before);
});

test("a commit touching a board file and the lane's own file still trips, and holds the lane", () => {
  const r = boardRepo();
  build(lane(r, "start", "T1").json);
  append(r.root, "plan/BOARD.md", "\nA line.");
  writeFileSync(join(r.root, "out.txt"), "x\n");
  git(r.root, "add", "plan/BOARD.md", "out.txt");
  git(r.root, "commit", "-q", "-m", "chore: board and code");
  assert.match(
    tripped(lane(r, "report", "T1")),
    /^main touched: HEAD moved [0-9a-f]{7} → [0-9a-f]{7} \([0-9a-f]{7} touches out\.txt, this lane's files\)$/,
  );
});

test("a board file a running lane owns trips that lane, committed or not; a commit of it passes the other lane", () => {
  const committed = repo({ tasks: OWNS_BOARD });
  build(lane(committed, "start", "T2").json, "two.txt");
  const t1 = lane(committed, "start", "T1").json;
  const sha = commitFile(
    committed.root,
    "plan/BOARD.md",
    `${board(committed.root)}\nBy hand.\n`,
    "docs: board",
  );
  const t2 = lane(committed, "report", "T2");
  assert.equal(t2.json.next, "verify", JSON.stringify(t2.json.guards));
  build(t1);
  assert.ok(
    tripped(lane(committed, "report", "T1")).includes(
      `(${sha.slice(0, 7)} touches plan/BOARD.md, this lane's files)`,
    ),
    "the overlap is named",
  );
  const edited = repo({ tasks: OWNS_BOARD });
  build(lane(edited, "start", "T2").json, "two.txt");
  assert.equal(lane(edited, "start", "T1").exit, 0);
  append(edited.root, "plan/DECISIONS.md", "By hand.");
  assert.match(tripped(lane(edited, "report", "T2")), /files changed: {2}M plan\/DECISIONS\.md/);
});

test("a code file on main holds the lane with its report saved; once guard.allow names it, a second report goes on to verify", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out);
  mkdirSync(join(r.root, "src"));
  writeFileSync(join(r.root, "src", "app.js"), "x\n");
  const held = lane(r, "report", "T1");
  const trip = tripped(held);
  assert.equal(trip, "main touched: files changed: ?? src/app.js");
  assert.equal(held.json.hold.report, out.reportPath.replace(/\.md$/, ".held.md"));
  const shown = spawnSync("node", [LANE, "exec", "report", "T1", "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home },
  });
  assert.equal(shown.status, 0, shown.stderr);
  const lines = shown.stdout.split("\n");
  assert.equal(lines[0], "T1 · report → resume (held)");
  assert.match(
    lines[1],
    /^held: guard tripped: files changed: \?\? src\/app\.js → fix it \(commit it between lanes, or add the path to guard\.allow\), then run .*exec report T1 --root .* again$/,
  );
  assert.ok(
    lines.some((l) => /^run: .*exec report T1 --root /.test(l)),
    shown.stdout,
  );
  // Still tripped: held again with the new reason, since the first trip.
  const since = held.json.hold.since;
  writeFileSync(join(r.root, "stray.txt"), "x\n");
  const again = lane(r, "report", "T1");
  assert.match(tripped(again), /files changed: \?\? src\/app\.js, \?\? stray\.txt$/);
  assert.equal(again.json.hold.since, since);
  rmSync(join(r.root, "stray.txt"));
  editWorkflow(r.root, (w) => ({ ...w, guard: { allow: ["src/app.js"] } }));
  git(r.root, "add", ".agentry/workflow.json");
  git(r.root, "commit", "-q", "-m", "chore: allow src/app.js");
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual([res.json.state, res.json.next], ["verifying", "verify"]);
  assert.match(res.json.guards[0], /^main moved by allowed commits: 1 /);
  assert.equal(ledgerOf(r.root, "T1").hold, undefined);
  assert.deepEqual(
    row(r.root, "T1"),
    ["T1", "S1", "verify", "", ""],
    "built written once it goes on",
  );
});

test("the guard hold never discards the report: a report again works with the builder's file gone", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out);
  writeFileSync(join(r.root, "stray.txt"), "x\n");
  tripped(lane(r, "report", "T1"));
  rmSync(join(r.root, "stray.txt"));
  rmSync(out.reportPath);
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(res.json.next, "verify");
  assert.equal(ledgerOf(r.root, "T1").rounds[0].status, "DONE");
});

test("a guard trip on a fix round holds the lane the same way, and the report again goes on to recheck", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1", "--agent", "builder-1").json;
  judge(out, "FAIL");
  const fix = lane(r, "verdict", "T1", "--agent", "verifier-1").json;
  assert.equal(fix.next, "fix");
  commitFile(fix.worktree, "fixed.txt", "x\n", "fix: the fail");
  writeFileSync(fix.reportPath, "DONE\nfixed\nused_memories: none\n");
  writeFileSync(join(r.root, "stray.txt"), "x\n");
  const held = lane(r, "report", "T1");
  tripped(held);
  assert.equal(held.json.hold.round, 3);
  rmSync(join(r.root, "stray.txt"));
  const res = lane(r, "report", "T1");
  assert.equal(res.json.next, "recheck", res.stderr);
  assert.equal(res.json.agent, "verifier-1");
});

test("a lane held for the guard is no writer; hold --for later parks it and resume carries the round on", () => {
  const r = repo({ config: { lanes: { maxWriters: 1 } } });
  build(lane(r, "start", "T1").json);
  writeFileSync(join(r.root, "stray.txt"), "x\n");
  tripped(lane(r, "report", "T1"));
  const t2 = lane(r, "start", "T2");
  assert.equal(t2.exit, 0, t2.stderr);
  const parked = lane(r, "hold", "T1", "--for", "later", "--note", "later");
  assert.equal(parked.exit, 0, parked.stderr);
  assert.equal(ledgerOf(r.root, "T1").hold.for, "later");
  assert.match(lane(r, "report", "T1").stderr, /the lane expects resume now, not a report/);
  rmSync(join(r.root, "stray.txt"));
  const r2 = repo();
  build(lane(r2, "start", "T1").json);
  writeFileSync(join(r2.root, "stray.txt"), "x\n");
  tripped(lane(r2, "report", "T1"));
  rmSync(join(r2.root, "stray.txt"));
  const resumed = lane(r2, "resume", "T1", "--note", "main is clean again");
  assert.equal(resumed.exit, 0, resumed.stderr);
  assert.equal(resumed.json.next, "continue");
});

test("show on a stopped lane names the reason and its ways on; the ledger is left as it was", () => {
  const r = repo();
  build(lane(r, "start", "T1").json, "out.txt", "BLOCKED");
  assert.equal(lane(r, "report", "T1").exit, 1);
  const file = ledgerFile(r.root, "T1");
  const before = readFileSync(file, "utf8");
  const shown = spawnSync("node", [LANE, "exec", "show", "T1", "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home },
  });
  assert.equal(shown.status, 1);
  const lines = shown.stdout.split("\n");
  assert.equal(lines[1], "stopped: the builder reported BLOCKED");
  assert.match(
    lines[2],
    /^ways on: .*merge T1 --branch agentry\/T1 --root .* \(lands as is, the owner's call\) · .*exec restart T1 --root .* --carry \(starts it again with its work\)$/,
  );
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(lane(r, "show", "T1").json.stopped, "the builder reported BLOCKED");
});

test("an old ledger stopped by a guard trip stays stopped: only show's text is new", () => {
  const r = repo();
  build(lane(r, "start", "T1").json);
  const file = ledgerFile(r.root, "T1");
  const old = JSON.parse(readFileSync(file, "utf8"));
  old.rounds[0].guards = ["main touched: HEAD moved"];
  Object.assign(old, { state: "stopped", next: "stop", stopReason: "main touched: HEAD moved" });
  writeFileSync(file, JSON.stringify(old, null, 2));
  const before = readFileSync(file, "utf8");
  assert.equal(lane(r, "show", "T1").json.stopped, "main touched: HEAD moved");
  assert.match(lane(r, "report", "T1").stderr, /the lane expects nothing now, not a report/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("fix --notes takes a label the ledger keeps open from an earlier report, quoting it from there", () => {
  const r = repo({ spec: { ...SPEC, exec: { noteRounds: 2, final: "never" } } });
  let out = lane(r, "start", "T1").json;
  build(out);
  out = lane(r, "report", "T1", "--agent", "builder-1").json;
  notesReport(out);
  lane(r, "verdict", "T1", "--agent", "verifier-1");
  const fixed = lane(r, "fix", "T1", "--notes", "N2").json;
  commitFile(fixed.worktree, "n2.txt", "x\n", "fix: the queue");
  writeFileSync(fixed.reportPath, "DONE\nfixed N2\nused_memories: none\n");
  const recheck = lane(r, "report", "T1").json;
  writeFileSync(
    recheck.reportPath,
    "N2: PASS the queue is kept\nused_memories: none\nVerdict: PASS WITH NOTES\n",
  );
  const judged = lane(r, "verdict", "T1");
  assert.equal(judged.exit, 0, judged.stderr);
  const open = ledgerOf(r.root, "T1").openNotes;
  assert.ok(
    open.some((n) => n.startsWith("N3 ")),
    JSON.stringify(open),
  );
  const again = lane(r, "fix", "T1", "--notes", "N3");
  assert.equal(again.exit, 0, again.stderr);
  assert.match(readFileSync(again.json.brief, "utf8"), /- N3: minor naming/);
});

test("start refuses while a land's picks are on main: exit 2, nothing written; a rolled-back land does not", () => {
  const r = repo();
  const pre = git(r.root, "rev-parse", "HEAD");
  const sha = commitFile(r.root, "landed.txt", "x\n", "feat: a pick");
  const at = new Date().toISOString();
  const ledger = (landed) =>
    JSON.stringify({
      v: 1,
      id: "ZZ",
      state: "merging",
      worktree: "/gone",
      owned: [],
      merge: { preHead: pre, landed, step: "gating", at },
    });
  mkdirSync(dirname(ledgerFile(r.root, "ZZ")), { recursive: true });
  writeFileSync(ledgerFile(r.root, "ZZ"), ledger([sha]));
  const before = board(r.root);
  const res = lane(r, "start", "T1");
  assert.equal(res.exit, 2);
  const hhmm = /since (\d\d:\d\d)\)/.exec(res.stderr)?.[1];
  assert.ok(hhmm, res.stderr);
  assert.match(
    res.stderr,
    /✗ lane exec start T1: main is mid-land \(ZZ, since \d\d:\d\d\): its picks may still roll back → start after it lands, or (agentry lane|node .*lane\.mjs'?) merge ZZ --resolve landed\|rolled-back$/m,
  );
  assert.equal(existsSync(ledgerFile(r.root, "T1")), false);
  assert.equal(existsSync(join(r.root, ".agentry", "run", "worktrees", "T1")), false);
  assert.equal(board(r.root), before);
  writeFileSync(ledgerFile(r.root, "ZZ"), ledger(["f".repeat(40)])); // its picks are off main again
  assert.equal(lane(r, "start", "T1").exit, 0);
});

// ---- a rebased lane's guard starts at the commit it was rebased onto (R1d-23 N7) ---------------------

test("a lane rebased onto a main commit touching its file is not tripped by that commit at the rebase report", () => {
  const r = repo();
  verified(r, "T1", "out.txt");
  const hand = commitFile(r.root, "out.txt", "main side\n", "fix: out.txt on main");
  const rebase = lane(r, "rebase", "T1").json;
  assert.equal(rebase.next, "rebase");
  const res = spawnSync("git", ["-C", rebase.worktree, "rebase", "main"], { env: gitEnv });
  assert.notEqual(res.status, 0, "the rebase stops on out.txt");
  writeFileSync(join(rebase.worktree, "out.txt"), "made\nmain side\n");
  git(rebase.worktree, "add", "out.txt");
  spawnSync("git", ["-C", rebase.worktree, "rebase", "--continue"], {
    env: { ...gitEnv, GIT_EDITOR: "true" },
  });
  writeFileSync(rebase.reportPath, "DONE\nrebased onto main\nused_memories: none\n");
  const reported = lane(r, "report", "T1");
  assert.equal(reported.exit, 0, reported.stderr);
  assert.equal(reported.json.hold, undefined, JSON.stringify(reported.json.guards));
  assert.equal(reported.json.next, "resolve");
  assert.equal(
    ledgerOf(r.root, "T1").mainAtStart.head,
    hand,
    "the guard starts at the rebase target",
  );
});
