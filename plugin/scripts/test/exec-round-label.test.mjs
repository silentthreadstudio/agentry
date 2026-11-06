// Tests for round labels: a round the lane held before its report was read (parked, the builder stopped
// for a restart) is shown as `r<n> (restart)` in `lane exec show`, its number unchanged; a round that
// reported, or whose report a guard held, is not.
// Run: node --test plugin/scripts/test/exec-round-label.test.mjs
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
import { heldText } from "../lib/lane/exec-view.mjs";
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
  name: "Hold",
  root: "plan",
  kinds: {
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: { status: { column: "Status" }, verdict: { column: "Verdict" } },
      status: {
        field: "status",
        values: { todo: "planned", doing: "active", verify: "active", done: "done" },
      },
      contract: { blocks: ["TASKS.md"] },
    },
  },
  rules: [{ rule: "ids-unique" }],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", built: "verify", failed: "doing", merged: "done" },
    write: { status: "status", verdict: "verdict" },
  },
  gate: { tiers: [{ name: "full", command: ["sh", "-c", "true"] }] },
};
const BOARD_MD = `# Hold

## Tasks

| Task | Status | Verdict |
| ---- | ------ | ------- |
| T3   | todo   |         |
`;
const TASKS_MD = `# Tasks

### T3 · No steps

- **Owns:** \`three.txt\`. Accept: three.txt exists.
`;

function repo(config) {
  const root = temp("hold-repo-");
  const home = temp("hold-home-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agentry"));
  if (config) writeFileSync(join(root, ".agentry", "config.json"), JSON.stringify(config));
  commitFile(root, ".gitignore", ".agentry/run/\n.agentry/config.json\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  // The board keys in process.json, the workflow keys in its sibling workflow.json.
  writeSpec(join(root, ".agentry"), SPEC);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
  return { root, home };
}
const spawnLane = ({ root, home }, args) =>
  spawnSync("node", [LANE, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home },
  });
function lane(r, ...args) {
  const res = spawnLane(r, ["exec", ...args, "--json"]);
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* a refusal on stderr */
  }
  return { exit: res.status, json, stderr: res.stderr };
}
const text = (r, ...args) => spawnLane(r, ["exec", ...args]).stdout;
const board = (root) => readFileSync(join(root, "plan", "BOARD.md"), "utf8");
const ledgerOf = (root, id) =>
  JSON.parse(
    readFileSync(join(root, ".agentry", "run", "process", "ledger", `${id}.json`), "utf8"),
  );
function build(out, file, status = "DONE") {
  commitFile(out.worktree, file, "made\n", `feat: add ${file}`);
  writeFileSync(out.reportPath, `${status}\nadded ${file}\nused_memories: none\n`);
}

const labels = (r) => lane(r, "show", "T3").json.rounds.map((x) => x.label ?? `r${x.n}`);

test("a parked round shows as restart in exec show, and the round after it is numbered on", () => {
  const r = repo();
  lane(r, "start", "T3");
  assert.deepEqual(labels(r), ["r1"]);
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  assert.deepEqual(labels(r), ["r1 (restart)"]);
  const resumed = lane(r, "resume", "T3", "--note", "restarted");
  assert.equal(resumed.exit, 0, resumed.stderr);
  build(resumed.json, "three.txt");
  assert.deepEqual(labels(r), ["r1 (restart)", "r2"]);
});

test("a round that reported is not labelled restart", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  build(out, "three.txt");
  assert.equal(lane(r, "report", "T3").exit, 0);
  assert.deepEqual(labels(r), ["r1", "r2"]);
});
