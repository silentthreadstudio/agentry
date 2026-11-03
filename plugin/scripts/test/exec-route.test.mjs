// Tests for the exec lane's fewer-round-trips keys on temp git repos: `exec.verify` (all | flagged | none) sends
// a built item straight to the gate unless its flag is set, `models` names the model each dispatch prints, and
// a verify brief on a tip whose gate is already green says to read that gate, not re-run it. A builder or
// verifier is simulated by committing in the worktree and writing its report file.
// Run: node --test plugin/scripts/test/exec-route.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSpec } from "../lib/process/spec.mjs";
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
  name: "Route",
  root: "plan",
  kinds: {
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: {
        status: { column: "Status" },
        verdict: { column: "Verdict" },
        commit: { column: "Commit", type: "commits" },
        flag: { column: "Flag", type: "flag", mark: "x" },
      },
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
    write: { status: "status", verdict: "verdict", commit: "commit" },
  },
  gate: { command: ["sh", "-c", "test -f out.txt"] },
};
const BOARD_MD = `# Route

## Tasks

| Task | Status | Verdict | Commit | Flag |
| ---- | ------ | ------- | ------ | ---- |
| T1   | todo   |         |        |      |
| T2   | todo   |         |        | x    |
`;
// T1 owns a UI-shaped file (the designer builds it); T2 is flagged and owns a plain one.
const TASKS_MD = `# Tasks

- **T1**: owns \`out.txt\`, \`src/ui/panel.css\`. Accept: out.txt exists.
- **T2**: owns \`out.txt\`. Accept: out.txt exists.
`;

function repo(extra = {}) {
  const spec = { ...SPEC, ...extra };
  const root = temp("route-repo-");
  const home = temp("route-home-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agentry"));
  writeFileSync(join(root, ".agentry", "process.json"), JSON.stringify(spec, null, 2));
  commitFile(root, ".gitignore", ".agentry/run/\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", TASKS_MD);
  commitFile(root, ".agentry/process.json", JSON.stringify(spec, null, 2));
  return { root, home };
}
function lane({ root, home }, ...args) {
  const text = args.includes("--text");
  const res = spawnSync(
    "node",
    [
      LANE,
      "exec",
      ...args.filter((a) => a !== "--text"),
      ...(text ? [] : ["--json"]),
      "--root",
      root,
    ],
    {
      encoding: "utf8",
      env: { ...gitEnv, HOME: home },
    },
  );
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* text, or a refusal on stderr */
  }
  return { exit: res.status, json, stdout: res.stdout, stderr: res.stderr };
}
const ledgerOf = (root, id) =>
  JSON.parse(
    readFileSync(join(root, ".agentry", "run", "process", "ledger", `${id}.json`), "utf8"),
  );
const status = (root, id) =>
  readFileSync(join(root, "plan", "BOARD.md"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`| ${id} `))
    .split("|")[2]
    .trim();
function build(out) {
  commitFile(out.worktree, "out.txt", "made\n", "feat: add out.txt");
  writeFileSync(out.reportPath, "DONE\nadded out.txt\nused_memories: none\n");
}
const judge = (out, verdict) =>
  writeFileSync(out.reportPath, `Checked.\nused_memories: none\nVerdict: ${verdict}\n`);

// ---- exec.verify (#49) ------------------------------------------------------------------------------

test("exec.verify flagged: an item with no flag goes from built straight to the gate, then closes", () => {
  const r = repo({ exec: { verify: "flagged" } });
  const started = lane(r, "start", "T1");
  assert.match(started.json.route, /^flagged: this item is not flagged, so no verifier/);
  build(started.json);
  const built = lane(r, "report", "T1");
  assert.equal(built.exit, 0);
  assert.equal(built.json.next, "gate");
  assert.equal(built.json.prompt, undefined);
  assert.equal(status(r.root, "T1"), "verify"); // built is still written
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 0);
  assert.equal(gated.json.next, "close");
  const closed = lane(r, "close", "T1");
  assert.match(closed.json.episode.outcome, /^gated: no verifier read it/);
  assert.match(closed.json.episode.outcome, /verify route: flagged: this item is not flagged/);
  assert.equal(ledgerOf(r.root, "T1").state, "verified");
  assert.equal(ledgerOf(r.root, "T1").rounds.length, 1);
});

test("exec.verify flagged: a red gate still stops a lane with no verifier", () => {
  const r = repo({ exec: { verify: "flagged" }, gate: { command: ["sh", "-c", "exit 3"] } });
  build(lane(r, "start", "T1").json);
  lane(r, "report", "T1");
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.exit, 1);
  assert.equal(gated.json.next, "stop");
  assert.match(gated.json.reason, /worktree gate is red/);
});

test("exec.verify flagged: a flagged item keeps its independent verifier, exactly as today", () => {
  const r = repo({ exec: { verify: "flagged" } });
  const started = lane(r, "start", "T2");
  assert.match(started.json.route, /^flagged: this item is flagged, so a verifier reads it/);
  build(started.json);
  const built = lane(r, "report", "T2");
  assert.equal(built.json.next, "verify");
  assert.deepEqual(built.json.dispatch, { agent: "verifier" });
  judge(built.json, "PASS");
  const judged = lane(r, "verdict", "T2");
  assert.equal(judged.json.next, "gate");
  assert.equal(judged.json.verdict, "PASS");
});

test("an item flagged after the lane started is verified, in flagged mode", () => {
  const r = repo({ exec: { verify: "flagged" } });
  const started = lane(r, "start", "T1");
  build(started.json);
  // The owner flags it through the board writer, which the lane's main guard lets through.
  const BOARD = join(dirname(LANE), "board.mjs");
  const set = spawnSync(
    "node",
    [BOARD, "set", "task", "T1", "flag=x", "--apply", "--root", r.root],
    {
      encoding: "utf8",
      env: { ...gitEnv, HOME: r.home },
    },
  );
  assert.equal(set.status, 0, set.stdout + set.stderr);
  const built = lane(r, "report", "T1");
  assert.equal(built.json.next, "verify");
  assert.equal(ledgerOf(r.root, "T1").route.flagged, true);
});

test("exec.verify none: no item has a verifier, but a flagged one still does", () => {
  const r = repo({ exec: { verify: "none" } });
  const one = lane(r, "start", "T1");
  build(one.json);
  assert.equal(lane(r, "report", "T1").json.next, "gate");
  const two = lane(r, "start", "T2");
  build(two.json);
  assert.equal(lane(r, "report", "T2").json.next, "verify");
});

test("no exec key: every item has a verifier, as before", () => {
  const r = repo();
  const started = lane(r, "start", "T1");
  assert.equal(started.json.route, "all: every item has a verifier");
  build(started.json);
  assert.equal(lane(r, "report", "T1").json.next, "verify");
  assert.match(lane(r, "show", "T1").json.route, /^all:/);
});

test("exec.verify none with no gate in the process file still sends the item to a verifier", () => {
  const { gate, ...noGate } = SPEC;
  const r = repo({ ...noGate, exec: { verify: "none" }, gate: undefined });
  build(lane(r, "start", "T1").json);
  assert.equal(lane(r, "report", "T1").json.next, "verify");
});

test("show prints the route", () => {
  const r = repo({ exec: { verify: "flagged" } });
  lane(r, "start", "T1");
  assert.match(lane(r, "show", "T1").json.route, /^flagged: this item is not flagged/);
});

test("the process file refuses flagged without a flag field on the exec kind, and a bad route", () => {
  const noFlag = structuredClone(SPEC);
  const { flag, ...kept } = noFlag.kinds.task.fields;
  noFlag.kinds.task.fields = kept;
  const refused = parseSpec(JSON.stringify({ ...noFlag, exec: { verify: "flagged" } }));
  assert.match(
    refused.problems[0].message,
    /exec\.verify is "flagged", but the task kind has no field named "flag"/,
  );
  const wrongType = structuredClone(SPEC);
  wrongType.kinds.task.fields.flag.type = "text";
  assert.equal(
    parseSpec(JSON.stringify({ ...wrongType, exec: { verify: "flagged" } })).problems.length,
    1,
  );
  assert.deepEqual(
    parseSpec(JSON.stringify({ ...SPEC, exec: { verify: "flagged" } })).problems,
    [],
  );
  assert.deepEqual(parseSpec(JSON.stringify({ ...noFlag, exec: { verify: "none" } })).problems, []);
  const bad = parseSpec(JSON.stringify({ ...SPEC, exec: { verify: "some" } }));
  assert.match(bad.problems[0].message, /exec\.verify should be one of "all", "flagged", "none"/);
});

// ---- models (#50) -----------------------------------------------------------------------------------

const MODELS = {
  build: "builder-m",
  verify: { default: "verify-m", ui: "ui-m", flagged: "flag-m" },
};

test("every dispatch prints the model its role and item name", () => {
  const r = repo({ models: MODELS });
  // T1: a designer builds it, not flagged: build model, then the ui verifier's.
  const one = lane(r, "start", "T1");
  assert.equal(one.json.model, "builder-m");
  build(one.json);
  assert.equal(lane(r, "report", "T1").json.model, "ui-m");
  // T2: flagged, plain files: its verifier's model is the flagged one.
  const two = lane(r, "start", "T2");
  assert.equal(two.json.model, "builder-m");
  build(two.json);
  assert.equal(lane(r, "report", "T2").json.model, "flag-m");
});

test("a verify model falls back to default, and no models key prints no model line", () => {
  const r = repo({ models: { verify: { default: "verify-m" } } });
  const started = lane(r, "start", "T2");
  assert.equal(started.json.model, undefined); // no build model named
  build(started.json);
  assert.equal(lane(r, "report", "T2").json.model, "verify-m");
  const bare = repo();
  assert.equal(lane(bare, "start", "T1").json.model, undefined);
  assert.doesNotMatch(lane(bare, "show", "T1", "--text").stdout, /^model:/m);
});

test("the readable view prints a model: line", () => {
  const r = repo({ models: MODELS });
  assert.match(lane(r, "start", "T1", "--text").stdout, /^model: builder-m$/m);
});

test("models keys are checked at load", () => {
  assert.deepEqual(parseSpec(JSON.stringify({ ...SPEC, models: MODELS })).problems, []);
  const bad = parseSpec(JSON.stringify({ ...SPEC, models: { verify: { best: "x" } } }));
  assert.match(bad.problems[0].message, /models\.verify\.best is not a known key/);
});

// ---- a recorded green gate (#43) --------------------------------------------------------------------

test("a gate that went green on the tip is read, not re-run, in the waiting verify brief", () => {
  const r = repo();
  const started = lane(r, "start", "T1");
  build(started.json);
  const built = lane(r, "report", "T1");
  assert.match(readFileSync(built.json.brief, "utf8"), /Run the gate as the lane records it/);
  const gated = lane(r, "gate", "T1");
  assert.equal(gated.json.briefUpdated, built.json.brief);
  const text = readFileSync(built.json.brief, "utf8");
  const record = ledgerOf(r.root, "T1").gates[0];
  assert.ok(
    text.includes(
      `the gate is recorded green on ${record.commit.slice(0, 7)} (${record.log}): read it; do not re-run it`,
    ),
  );
  assert.doesNotMatch(text, /Run the gate as the lane records it/);
});

test("a tip that moved since the green gate gets the full gate line", () => {
  const r = repo();
  const started = lane(r, "start", "T1");
  build(started.json);
  const built = lane(r, "report", "T1");
  lane(r, "gate", "T1");
  commitFile(started.json.worktree, "more.txt", "x\n", "feat: more");
  judge(built.json, "PASS");
  const voided = lane(r, "verdict", "T1");
  assert.equal(voided.json.verdict, "void");
  const text = readFileSync(voided.json.brief, "utf8");
  assert.match(text, /Run the gate as the lane records it/);
  assert.doesNotMatch(text, /do not re-run it/);
});

test("a red gate leaves the full gate line in the verify brief", () => {
  const r = repo({ gate: { command: ["sh", "-c", "exit 1"] } });
  build(lane(r, "start", "T1").json);
  const built = lane(r, "report", "T1");
  assert.equal(lane(r, "gate", "T1").exit, 1);
  assert.match(readFileSync(built.json.brief, "utf8"), /Run the gate as the lane records it/);
});
