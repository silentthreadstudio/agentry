// Tests for a debt lane on throwaway git repos with a sprint/task board and a debt kind the workflow
// file's `exec.kinds` runs: `board add debt` writes the row and its light contract; `lane exec` runs a
// debt item from start to gate and `lane merge` lands it outside the sprints (no handoff, no sprint read);
// a light contract missing its Owns or Acceptance line refuses before anything is written; a debt lane and
// a task lane open at once pass each other's writes and land in either order; an id two kinds hold is
// refused on every step; a ledger from before kinds reads as the lifecycle kind.
// Run: node --test plugin/scripts/test/debt-lane.test.mjs
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
import { writeSpec } from "./spec-files.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE = join(HERE, "..", "lane.mjs");
const BOARD = join(HERE, "..", "board.mjs");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};

const STATUS = { todo: "planned", doing: "active", verify: "active", done: "done", cut: "dropped" };
const ON = { dispatched: "doing", built: "verify", failed: "doing", merged: "done" };
const WRITE = { status: "status", verdict: "verdict", commit: "commit" };
const SPEC = {
  version: 1,
  name: "Debt lanes",
  root: "plan",
  kinds: {
    sprint: {
      label: "Sprint",
      at: { table: "BOARD.md", heading: "Sprints" },
      id: { column: "Sprint" },
      fields: { status: { column: "Status" } },
      status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
      file: {
        glob: "sprints/{id}.md",
        sections: { handoff: { heading: "Handoff", as: "bold-lead" } },
      },
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
      status: { field: "status", values: STATUS },
      contract: { blocks: ["TASKS.md"] },
    },
    debt: {
      label: "Debt",
      at: { table: "BOARD.md", heading: "Debt" },
      id: { column: "Debt" },
      fields: {
        what: { column: "What" },
        status: { column: "Status" },
        verdict: { column: "Verdict" },
        commit: { column: "Commit", type: "commits" },
      },
      status: { field: "status", values: STATUS },
      contract: { blocks: ["TASKS.md"] },
      create: {
        ask: ["what", "owns", "acceptance"],
        id: "DEBT-{n}",
        rows: [
          {
            in: "self",
            at: "end",
            cells: { Debt: "{id}", What: "{what}", Status: "todo", Verdict: "", Commit: "" },
          },
        ],
        blocks: [
          {
            file: "TASKS.md",
            under: "# Debt",
            text: "### {id} · {what}\n- **Owns:** {owns}\n- **Acceptance:** {acceptance}",
          },
        ],
      },
    },
  },
  rules: [
    { rule: "ids-unique" },
    { rule: "status-known" },
    { rule: "done-has-evidence", kind: "task", field: "commit", evidence: "commit" },
    { rule: "done-has-handoff", kind: "task", section: "handoff", commit: "first" },
    { rule: "done-has-evidence", kind: "debt", field: "commit", evidence: "commit" },
  ],
  lifecycle: {
    kind: "task",
    on: ON,
    write: { ...WRITE, handoff: "parent.file:handoff" },
    handoff: "- **{id}** ({sha}): {summary}",
  },
  exec: { kinds: { debt: { on: ON, write: WRITE } } },
  gate: { tiers: [{ name: "full", command: ["node", "-e", "process.exit(0)"] }] },
};
const BOARD_MD = `# Board

## Sprints

| Sprint | Status |
| ------ | ------ |
| S1     | doing  |

## Tasks

| Task | Sprint | Status | Verdict | Commit |
| ---- | ------ | ------ | ------- | ------ |
| T1   | S1     | todo   |         |        |
| T2   | S1     | todo   |         |        |

## Debt

| Debt | What | Status | Verdict | Commit |
| ---- | ---- | ------ | ------- | ------ |
`;
const TASKS_MD = `# Debt

# Tasks

### T1 · The loop
- **Owns:** \`loop.txt\`
- **Acceptance:** loop.txt exists

### T2 · No owns
- **Acceptance:** something
`;
const SPRINT_MD = "# S1\n\n## Handoff\n\n## Notes\n\nNothing yet.\n";

// A repo on `main` with the board committed, a HOME of its own, and `debts` added through `board add`
// (each `[what, owns, acceptance]`) and committed.
function repo({ spec = SPEC, debts = [["Drop the flag", "`flag.txt`", "flag.txt is gone"]] } = {}) {
  const root = temp("debt-repo-");
  const home = temp("debt-home-");
  git(root, "init", "-q", "-b", "main");
  commitFile(root, ".gitignore", ".agentry/run/\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  commitFile(root, "plan/sprints/S1.md", SPRINT_MD);
  writeSpec(join(root, ".agentry"), spec);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
  const r = { root, home };
  for (const [what, owns, acceptance] of debts) {
    const res = boardCli(
      r,
      "add",
      "debt",
      "--fields",
      JSON.stringify({ what, owns, acceptance }),
      "--apply",
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
  }
  if (debts.length) {
    git(root, "add", "plan");
    git(root, "commit", "-q", "-m", "add the debt");
  }
  return r;
}
const boardCli = ({ root, home }, ...args) =>
  spawnSync("node", [BOARD, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home, NO_COLOR: "1" },
  });
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
  return { exit: res.status, json, stderr: res.stderr, stdout: res.stdout };
}
const merge = ({ root, home }, ...args) =>
  spawnSync("node", [LANE, "merge", ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home, NO_COLOR: "1" },
  });
const read = (root, file) => readFileSync(join(root, file), "utf8");
const board = (root) => read(root, "plan/BOARD.md");
const row = (root, id) =>
  board(root)
    .split("\n")
    .find((l) => l.startsWith(`| ${id} `))
    .split("|")
    .map((c) => c.trim())
    .slice(1, -1);
const ledgerFile = (root, id) => join(root, ".agentry", "run", "process", "ledger", `${id}.json`);
const ledgerOf = (root, id) => JSON.parse(readFileSync(ledgerFile(root, id), "utf8"));
const changedLines = (before, after) => {
  const a = before.split("\n");
  return after.split("\n").filter((line, i) => line !== a[i]);
};
const branches = (root) => git(root, "branch", "--list", "--format=%(refname:short)").split("\n");

function build(out, file) {
  commitFile(out.worktree, file, "made\n", `feat: add ${file}`);
  writeFileSync(out.reportPath, `DONE\nadded ${file}\nused_memories: none\n`);
}
const judge = (out, verdict = "PASS") =>
  writeFileSync(
    out.reportPath,
    `All acceptance items checked.\nused_memories: none\nVerdict: ${verdict}\n`,
  );
// A started lane `id`, built, reported, judged PASS, gated and closed.
function toVerified(r, id, file, started = lane(r, "start", id).json) {
  build(started, file);
  const reported = lane(r, "report", id);
  assert.equal(reported.json?.next, "verify", reported.stdout + reported.stderr);
  judge(reported.json);
  assert.equal(lane(r, "verdict", id).json.next, "gate");
  assert.equal(lane(r, "gate", id).exit, 0);
  assert.equal(lane(r, "close", id).exit, 0);
}

test("board add debt writes the row and its light contract in one write, logged", () => {
  const r = repo({ debts: [] });
  const fields = { what: "Split the reader", owns: "`a.txt`, `b.txt`", acceptance: "both exist" };
  const res = boardCli(r, "add", "debt", "--fields", JSON.stringify(fields), "--apply");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /added debt DEBT-1/);
  assert.deepEqual(row(r.root, "DEBT-1"), ["DEBT-1", "Split the reader", "todo", "", ""]);
  assert.match(
    read(r.root, "plan/TASKS.md"),
    /^# Debt\n\n### DEBT-1 · Split the reader\n- \*\*Owns:\*\* `a\.txt`, `b\.txt`\n- \*\*Acceptance:\*\* both exist\n/,
  );
  const log = read(r.root, ".agentry/run/process/board-writes.jsonl");
  assert.match(log, /plan\/BOARD\.md/);
  assert.match(log, /plan\/TASKS\.md/);
});

test("a debt lane runs from start to merge outside the sprints", () => {
  const r = repo();
  const before = board(r.root);
  const sprint = read(r.root, "plan/sprints/S1.md");
  const started = lane(r, "start", "debt-1");
  assert.equal(started.exit, 0, started.stderr);
  const out = started.json;
  assert.equal(out.id, "DEBT-1");
  assert.equal(out.branch, "agentry/DEBT-1");
  assert.equal(ledgerOf(r.root, "DEBT-1").kind, "debt");
  assert.deepEqual(changedLines(before, board(r.root)), [
    "| DEBT-1 | Drop the flag | doing |  |  |",
  ]);
  assert.match(readFileSync(out.brief, "utf8"), /- `flag\.txt` \(new\)/);

  toVerified(r, "DEBT-1", "flag.txt", out);
  assert.deepEqual(row(r.root, "DEBT-1"), ["DEBT-1", "Drop the flag", "verify", "PASS", ""]);
  const pre = merge(r, "DEBT-1", "--preflight");
  assert.equal(pre.status, 0, pre.stdout + pre.stderr);
  assert.match(pre.stdout, /debt DEBT-1 is "verify"; landing makes it "done"/);
  const landed = merge(r, "DEBT-1", "--message", "chore(board): land DEBT-1");
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.stdout, /skipped handoff: no handoff: debt is outside the tree/);

  const short = git(r.root, "log", "-1", "--format=%h", "--", "flag.txt");
  assert.deepEqual(row(r.root, "DEBT-1"), ["DEBT-1", "Drop the flag", "done", "PASS", short]);
  // Only the debt row changed (its status cell keeps the padding "verify" gave it).
  assert.deepEqual(
    changedLines(before, board(r.root)).map((l) => l.split("|")[1].trim()),
    ["DEBT-1"],
  );
  assert.equal(read(r.root, "plan/sprints/S1.md"), sprint);
  assert.deepEqual(git(r.root, "show", "--name-only", "--format=", "HEAD").split("\n"), [
    "plan/BOARD.md",
  ]);
  // nothing but the episode close wrote, in the repo's own memory store
  assert.equal(git(r.root, "status", "--porcelain"), "?? .agentry/memory/");
  const checked = boardCli(r, "check");
  assert.equal(checked.status, 0, checked.stdout);
  // The landed debt item is on the board, done: neither board fix nor the close plan reports it.
  const fix = JSON.parse(boardCli(r, "fix", "--json").stdout);
  assert.deepEqual(
    fix.left.filter((l) => l.startsWith("DEBT-1")),
    [],
  );
  const close = spawnSync("node", [LANE, "session", "close", "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home, NO_COLOR: "1" },
  });
  assert.equal(close.status, 0, close.stderr);
  assert.deepEqual(
    JSON.parse(close.stdout).fixPlan.left.filter((l) => l.startsWith("DEBT-1")),
    [],
  );
});

test("a debt lane and a task lane open at once pass each other's writes and land in either order", () => {
  for (const order of [
    ["DEBT-1", "T1"],
    ["T1", "DEBT-1"],
  ]) {
    const r = repo();
    const debt = lane(r, "start", "DEBT-1").json;
    const task = lane(r, "start", "T1").json;
    build(debt, "flag.txt");
    build(task, "loop.txt");
    for (const id of ["DEBT-1", "T1"]) {
      const reported = lane(r, "report", id);
      assert.equal(
        reported.json?.next,
        "verify",
        `${id}: ${JSON.stringify(reported.json?.guards)}`,
      );
      judge(reported.json);
    }
    for (const id of ["DEBT-1", "T1"]) {
      assert.equal(lane(r, "verdict", id).json.next, "gate", id);
      assert.equal(lane(r, "gate", id).exit, 0, id);
      assert.equal(lane(r, "close", id).exit, 0, id);
    }
    const [first, second] = order;
    const one = merge(r, first, "--message", `chore(board): land ${first}`);
    assert.equal(one.status, 0, one.stdout + one.stderr);
    assert.match(one.stdout, /clean but for exec's uncommitted lifecycle writes/);
    // The first land carried the other lane's cells into its board commit.
    const other =
      second === "T1"
        ? "| T1   | S1     | verify | PASS    |        |"
        : "| DEBT-1 | Drop the flag | verify | PASS |  |";
    assert.ok(git(r.root, "show", "HEAD:plan/BOARD.md").includes(other), `${first} first`);
    const two = merge(r, second, "--message", `chore(board): land ${second}`);
    assert.equal(two.status, 0, two.stdout + two.stderr);
    assert.equal(row(r.root, "DEBT-1")[2], "done");
    assert.equal(row(r.root, "T1")[2], "done");
    assert.equal(row(r.root, "T2")[2], "todo");
    // nothing but the episodes close wrote, in the repo's own memory store
    assert.equal(git(r.root, "status", "--porcelain"), "?? .agentry/memory/");
    assert.equal(boardCli(r, "check").status, 0);
  }
});

test("a light contract with no owned path or no Acceptance line refuses start, writing nothing", () => {
  const blocks = {
    "no path": "- **Owns:** `the flag`\n- **Acceptance:** done",
    "no owns": "- **Acceptance:** done",
    "acceptance only in prose": "- **Owns:** `flag.txt`\n- the acceptance is that it works",
    "an empty acceptance": "- **Owns:** `flag.txt`\n- **Acceptance:**",
    "labels only in a code fence":
      "Example:\n```\n- **Owns:** `flag.txt`\n- **Acceptance:** done\n```\n- **Owns:** `flag.txt`",
  };
  for (const [name, body] of Object.entries(blocks)) {
    const r = repo({ debts: [] });
    commitFile(r.root, "plan/BOARD.md", `${BOARD_MD}| DEBT-1 | x | todo |  |  |\n`);
    commitFile(
      r.root,
      "plan/TASKS.md",
      TASKS_MD.replace("# Debt\n", `# Debt\n\n### DEBT-1 · x\n${body}\n`),
    );
    const before = board(r.root);
    const res = lane(r, "start", "DEBT-1");
    assert.equal(res.exit, 2, name);
    assert.match(
      res.stderr,
      /contract DEBT-1 is light and needs an Owns line naming files and an Acceptance line: plan\/TASKS\.md:3/,
      name,
    );
    assert.equal(board(r.root), before, name);
    assert.ok(!branches(r.root).includes("agentry/DEBT-1"), name);
    assert.ok(!existsSync(join(r.root, ".agentry", "run", "worktrees", "DEBT-1")), name);
    assert.ok(!existsSync(ledgerFile(r.root, "DEBT-1")), name);
  }
});

test("a light contract reads its labels: prose owns first, a lower-case acceptance", () => {
  const r = repo({ debts: [] });
  commitFile(r.root, "plan/BOARD.md", `${BOARD_MD}| DEBT-1 | x | todo |  |  |\n`);
  const body = "Nobody owns this yet.\n- **Owns:** `flag.txt`\n- **acceptance:** flag.txt is gone";
  commitFile(
    r.root,
    "plan/TASKS.md",
    TASKS_MD.replace("# Debt\n", `# Debt\n\n### DEBT-1 · x\n${body}\n`),
  );
  const res = lane(r, "start", "DEBT-1");
  assert.equal(res.exit, 0, res.stderr);
  assert.deepEqual(res.json.owned, [{ path: "flag.txt", new: true }]);
});

test("a task contract with no owns still starts", () => {
  const r = repo();
  const res = lane(r, "start", "T2");
  assert.equal(res.exit, 0, res.stderr);
  assert.equal(ledgerOf(r.root, "T2").kind, "task");
});

test("an id two kinds hold is refused on start, report and merge, writing nothing", () => {
  const r = repo();
  commitFile(r.root, "plan/BOARD.md", board(r.root).replace("| DEBT-1 |", "| T2 |"));
  const before = board(r.root);
  for (const step of ["start", "report"]) {
    const res = lane(r, step, "t2");
    assert.equal(res.exit, 2, step);
    assert.match(res.stderr, /"t2" names a task and a debt/, step);
  }
  const res = merge(r, "t2", "--preflight");
  assert.equal(res.status, 2);
  assert.match(res.stderr, /"t2" names a task and a debt/);
  assert.equal(board(r.root), before);
  assert.ok(!existsSync(ledgerFile(r.root, "T2")));
  assert.equal(git(r.root, "status", "--porcelain"), "");
});

test("a ledger with no kind reads as the lifecycle kind", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  const { kind: _kind, ...ledger } = ledgerOf(r.root, "T1");
  writeFileSync(ledgerFile(r.root, "T1"), JSON.stringify(ledger));
  build(out, "loop.txt");
  const reported = lane(r, "report", "T1");
  assert.equal(reported.json.next, "verify", JSON.stringify(reported.json.guards));
  assert.equal(row(r.root, "T1")[2], "verify");
});

test("a flagged debt item no verifier read does not land", () => {
  const spec = structuredClone(SPEC);
  for (const kind of ["task", "debt"])
    spec.kinds[kind].fields.flag = { column: "Flag", type: "flag", mark: "⚑" };
  spec.exec.verify = "flagged";
  const r = repo({ spec, debts: [] });
  const header =
    "| Debt | What | Status | Verdict | Commit | Flag |\n| ---- | ---- | ------ | ------- | ------ | ---- |\n";
  const tasks =
    "| Task | Sprint | Status | Verdict | Commit | Flag |\n| ---- | ------ | ------ | ------- | ------ | ---- |\n| T1   | S1     | todo   |         |        |      |\n";
  const text = BOARD_MD.replace(
    /## Tasks\n\n[\s\S]*?\n\n## Debt/,
    `## Tasks\n\n${tasks}\n## Debt`,
  ).replace(/## Debt\n\n[\s\S]*$/, `## Debt\n\n${header}| DEBT-1 | x | todo |  |  |  |\n`);
  commitFile(r.root, "plan/BOARD.md", text);
  commitFile(
    r.root,
    "plan/TASKS.md",
    TASKS_MD.replace(
      "# Debt\n",
      "# Debt\n\n### DEBT-1 · x\n- **Owns:** `flag.txt`\n- **Acceptance:** gone\n",
    ),
  );
  const out = lane(r, "start", "DEBT-1").json;
  build(out, "flag.txt");
  assert.equal(lane(r, "report", "DEBT-1").json.next, "gate");
  assert.equal(lane(r, "gate", "DEBT-1").exit, 0);
  assert.equal(lane(r, "close", "DEBT-1").exit, 0);
  // The flag is set on the board after the lane skipped its verifier: the land refuses.
  const flagged = board(r.root).replace(
    "| DEBT-1 | x | verify |  |  |  |",
    "| DEBT-1 | x | verify |  |  | ⚑ |",
  );
  writeFileSync(join(r.root, "plan", "BOARD.md"), flagged);
  git(r.root, "commit", "-q", "-am", "flag DEBT-1");
  const res = merge(r, "DEBT-1", "--preflight");
  assert.equal(res.status, 2, res.stdout);
  assert.match(res.stdout + res.stderr, /DEBT-1 is flagged on the board, but no verifier read it/);
});

// ---- no lifecycle: every step prints what it printed before kinds -----------------------------------

// Thirteen steps on a repo whose workflow file has no lifecycle, with `plugin`'s scripts: three
// `board lifecycle` calls, the exec steps start to close, the merge preflight and land, `board fix` and
// `board status`. Paths, SHAs, times and durations normalised. The golden file is this, run with the
// plugin as it was before the debt kind (463ab93).
function noLifecycleRun(plugin) {
  const env = {
    ...gitEnv,
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const run = (dir, ...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  const commit = (dir, file, text, subject = `add ${file}`) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
    run(dir, "add", file);
    run(dir, "commit", "-q", "-m", subject);
  };
  const lane = join(plugin, "scripts", "lane.mjs");
  const cli = join(plugin, "scripts", "board.mjs");
  const root = temp("debt-golden-");
  const home = temp("debt-golden-home-");
  run(root, "init", "-q", "-b", "main");
  commit(root, ".gitignore", ".agentry/run/\n");
  commit(
    root,
    "plan/BOARD.md",
    "# B\n\n## Tasks\n\n| Task | Status | Commit |\n| --- | --- | --- |\n| T-1 | todo | |\n",
  );
  commit(
    root,
    "plan/TASKS.md",
    "# Tasks\n\n### T-1 · One\n- **Owns:** `one.txt`\n- **Acceptance:** one exists\n",
  );
  writeSpec(join(root, ".agentry"), {
    version: 1,
    name: "Golden",
    root: "plan",
    kinds: {
      task: {
        label: "Task",
        at: { table: "BOARD.md", heading: "Tasks" },
        id: { column: "Task" },
        fields: { status: { column: "Status" }, commit: { column: "Commit", type: "commits" } },
        status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
        contract: { blocks: ["TASKS.md"] },
      },
    },
    rules: [{ rule: "ids-unique" }, { rule: "status-known" }],
    gate: { tiers: [{ name: "full", command: ["node", "-e", "process.exit(0)"] }] },
  });
  run(root, "add", ".agentry");
  run(root, "commit", "-q", "-m", "process");
  const out = [];
  const step = (label, script, ...args) => {
    const r = spawnSync("node", [script, ...args, "--root", root], {
      encoding: "utf8",
      env: { ...env, HOME: home, NO_COLOR: "1" },
    });
    out.push(`--- ${label}: exit ${r.status}\n${r.stdout}${r.stderr}`);
    return r;
  };
  step("lifecycle dispatched t-1", cli, "lifecycle", "dispatched", "t-1");
  step("lifecycle dispatched t-1 --json", cli, "lifecycle", "dispatched", "t-1", "--json");
  step("lifecycle bad event", cli, "lifecycle", "nope", "t-1");
  const started = JSON.parse(step("exec start t-1", lane, "exec", "start", "t-1", "--json").stdout);
  commit(started.worktree, "one.txt", "1\n", "feat: one");
  writeFileSync(started.reportPath, "DONE\nused_memories: none\n");
  step("exec report T-1", lane, "exec", "report", "T-1");
  const shown = JSON.parse(
    step("exec show T-1 --json", lane, "exec", "show", "T-1", "--json").stdout,
  );
  writeFileSync(shown.reportPath, "ok\nused_memories: none\nVerdict: PASS\n");
  step("exec verdict", lane, "exec", "verdict", "T-1");
  step("exec gate", lane, "exec", "gate", "T-1");
  step("exec close", lane, "exec", "close", "T-1");
  step("merge preflight", lane, "merge", "t-1", "--preflight");
  step("merge", lane, "merge", "T-1", "--message", "chore(board): land T-1");
  step("board fix", cli, "fix");
  step("board status", cli, "status");
  return out
    .join("\n")
    .replaceAll(root, "<ROOT>")
    .replaceAll(plugin, "<PLUGIN>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<SHA>")
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<TIME>")
    .replace(/\b\d{1,2}:\d\d(:\d\d)?\b/g, "<HM>")
    .replace(/"seconds": [\d.]+/g, '"seconds": <N>')
    .replace(/\d+(\.\d+)? ?(ms|s)\b/g, "<DUR>");
}

test("with no lifecycle, every step prints what it printed before the debt kind (golden)", () => {
  const golden = readFileSync(
    join(HERE, "fixtures", "debt-board", "golden-no-lifecycle.txt"),
    "utf8",
  );
  assert.equal(noLifecycleRun(join(HERE, "..", "..")), golden);
});
