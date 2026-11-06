// A debt land two ways, same id: a debt kind declared in `exec.kinds` writes no handoff line (the record row
// says why) and a debt kept as a task on the lifecycle board writes one like any task (the merge docs).
// Run: node --test plugin/scripts/test/merge-debt-handoff.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

test("a debt kind declared in exec.kinds lands with no handoff line, the record row saying why", () => {
  const r = repo();
  toVerified(r, "DEBT-1", "flag.txt");
  const landed = merge(r, "DEBT-1", "--message", "chore(board): land DEBT-1");
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.stdout, /skipped handoff: no handoff: debt is outside the tree/);
  assert.equal(read(r.root, "plan/sprints/S1.md"), SPRINT_MD);
});

test("the same id kept as a task on the lifecycle board writes its handoff line like any task", () => {
  const spec = JSON.parse(JSON.stringify(SPEC));
  spec.exec = undefined;
  spec.kinds.debt = undefined;
  spec.rules = spec.rules.filter((x) => x.kind !== "debt");
  const root = temp("plain-repo-");
  const home = temp("plain-home-");
  git(root, "init", "-q", "-b", "main");
  commitFile(root, ".gitignore", ".agentry/run/\n");
  commitFile(
    root,
    "plan/BOARD.md",
    BOARD_MD.replace(
      "| T2   | S1     | todo   |         |        |",
      "| T2   | S1     | todo   |         |        |\n| DEBT-1 | S1   | todo   |         |        |",
    ),
  );
  commitFile(
    root,
    "plan/TASKS.md",
    `${TASKS_MD}\n### DEBT-1 · Drop the flag\n- **Owns:** \`flag.txt\`\n- **Acceptance:** flag.txt exists\n`,
  );
  commitFile(root, "plan/sprints/S1.md", SPRINT_MD);
  writeSpec(join(root, ".agentry"), spec);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
  const r = { root, home };
  toVerified(r, "DEBT-1", "flag.txt");
  const landed = merge(r, "DEBT-1", "--message", "chore(board): land DEBT-1");
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.doesNotMatch(landed.stdout, /no handoff/);
  assert.match(read(root, "plan/sprints/S1.md"), /\*\*DEBT-1\*\* \(/);
});
