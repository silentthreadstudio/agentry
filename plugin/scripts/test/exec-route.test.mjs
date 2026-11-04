// Tests for the exec lane's fewer-round-trips keys on temp git repos: `exec.verify` (all | flagged | none) sends
// a built item straight to the gate unless its flag is set, `models` names the model each dispatch prints,
// a verify brief on a tip whose gate is already green says to read that gate, not re-run it, and the presets'
// keys: notes rounds, the final after a fix, the route fixed at start, reverify, the flag field and the idle
// threshold. A builder or
// verifier is simulated by committing in the worktree and writing its report file.
// Run: node --test plugin/scripts/test/exec-route.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { idleHead } from "../lib/lane/exec-view.mjs";
import { validateSpec } from "../lib/process/spec.mjs";
import { modelFor, unusedUiModel } from "../lib/process/spec/models.mjs";
import { commitFile, git, gitEnv } from "./git-repo.mjs";
import { splitSpec, writeSpec } from "./spec-files.mjs";

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
  gate: { tiers: [{ name: "full", command: ["sh", "-c", "test -f out.txt"] }] },
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

function repo(extra = {}, tasks = TASKS_MD) {
  const spec = { ...SPEC, ...extra };
  const root = temp("route-repo-");
  const home = temp("route-home-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agentry"));
  commitFile(root, ".gitignore", ".agentry/run/\n");
  commitFile(root, "plan/BOARD.md", BOARD_MD);
  commitFile(root, "plan/TASKS.md", tasks);
  writeSpec(join(root, ".agentry"), spec);
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
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
  const r = repo({
    exec: { verify: "flagged" },
    gate: { tiers: [{ name: "full", command: ["sh", "-c", "exit 3"] }] },
  });
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

test("the workflow file refuses flagged without a flag field on the exec kind, and a bad route", () => {
  const noFlag = structuredClone(SPEC);
  const { flag, ...kept } = noFlag.kinds.task.fields;
  noFlag.kinds.task.fields = kept;
  const refused = validateSpec(splitSpec({ ...noFlag, exec: { verify: "flagged" } }));
  assert.match(
    refused.problems[0].message,
    /exec\.verify is "flagged" \(set\), but the task kind has no field named "flag"/,
  );
  const wrongType = structuredClone(SPEC);
  wrongType.kinds.task.fields.flag.type = "text";
  assert.equal(
    validateSpec(splitSpec({ ...wrongType, exec: { verify: "flagged" } })).problems.length,
    1,
  );
  assert.deepEqual(validateSpec(splitSpec({ ...SPEC, exec: { verify: "flagged" } })).problems, []);
  assert.deepEqual(validateSpec(splitSpec({ ...noFlag, exec: { verify: "none" } })).problems, []);
  const bad = validateSpec(splitSpec({ ...SPEC, exec: { verify: "some" } }));
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

test("the readable view prints a model: line naming its source", () => {
  const r = repo({ models: MODELS });
  const started = lane(r, "start", "T1", "--text").stdout;
  assert.match(started, /^model: builder-m \(models\.build\)$/m);
  assert.doesNotMatch(started, /^modelFrom:/m);
  assert.equal(lane(r, "show", "T1").json.modelFrom, "models.build");
});

// ---- models by path and by contract (field 73) ---------------------------------------------------

const BY_PATH = {
  build: {
    default: "sonnet",
    paths: [
      { when: { any: ["docs/**"] }, model: "haiku" },
      { when: { any: ["src/main/**", "src/ui/**"] }, model: "opus" },
    ],
  },
  verify: {
    ui: { default: "ui-m", paths: [{ when: { any: ["src/ui/*.css"] }, model: "ui-css" }] },
    default: "verify-m",
  },
};

test("a model by path: the first entry matching an owned file wins and is named, else its default", () => {
  const r = repo({ models: BY_PATH });
  // T1 owns src/ui/panel.css: paths[1] matches on its second glob (paths[0] does not).
  const one = lane(r, "start", "T1");
  assert.deepEqual(
    [one.json.model, one.json.modelFrom],
    ["opus", "models.build.paths[1]: src/ui/**"],
  );
  assert.match(
    lane(r, "show", "T1", "--text").stdout,
    /^model: opus \(models\.build\.paths\[1\]: src\/ui\/\*\*\)$/m,
  );
  build(one.json);
  const verifier = lane(r, "report", "T1").json;
  assert.deepEqual(
    [verifier.model, verifier.modelFrom],
    ["ui-css", "models.verify.ui.paths[0]: src/ui/*.css"],
  );
  // T2 owns only out.txt: no entry matches, so the default.
  const two = lane(r, "start", "T2");
  assert.deepEqual([two.json.model, two.json.modelFrom], ["sonnet", "models.build.default"]);
});

const CONTRACT_MODEL = `# Tasks

### T1 · With its own models

- **Owns:** \`out.txt\`, \`src/ui/panel.css\`
- **Model:** \`opus\`
- **Model (verify):** haiku-4 for the hard parts
- **Acceptance:** out.txt exists.

### T2 · A build model only

- **Owns:** \`out.txt\`
- **Model:** opus
- **Acceptance:** out.txt exists.
`;

test("a contract's Model bullets win over the workflow file's, named as the contract", () => {
  const r = repo({ models: BY_PATH }, CONTRACT_MODEL);
  const one = lane(r, "start", "T1");
  assert.equal(one.exit, 0, one.stderr);
  assert.deepEqual([one.json.model, one.json.modelFrom], ["opus", "contract"]);
  assert.match(lane(r, "show", "T1", "--text").stdout, /^model: opus \(contract\)$/m);
  build(one.json);
  const verifier = lane(r, "report", "T1").json;
  assert.deepEqual([verifier.model, verifier.modelFrom], ["haiku-4", "contract"]);
  // T2 names a build model only: its verifier's comes from the workflow file (flagged, so default).
  const two = lane(r, "start", "T2");
  assert.deepEqual([two.json.model, two.json.modelFrom], ["opus", "contract"]);
  build(two.json);
  const check = lane(r, "report", "T2").json;
  assert.deepEqual([check.model, check.modelFrom], ["verify-m", "models.verify.default"]);
});

// ---- a verify model the route never uses (field 70) ------------------------------------------------

const UNUSED =
  "! models.verify.ui is unused: exec.verify is flagged and a UI task is verified only when flagged";

test("start's route line warns of models.verify.ui for a UI-shaped item that is not flagged", () => {
  const r = repo({ exec: { verify: "flagged" }, models: MODELS });
  const one = lane(r, "start", "T1");
  assert.equal(
    one.json.route,
    `flagged: this item is not flagged, so no verifier; built goes straight to the gate · ${UNUSED}`,
  );
  // T2 is flagged (a verifier reads it), and plain: no warning.
  assert.doesNotMatch(lane(r, "start", "T2").json.route, /unused/);
  // Every item verified: the ui model is used.
  const all = repo({ models: MODELS });
  assert.doesNotMatch(lane(all, "start", "T1").json.route, /unused/);
});

test("models keys are checked at load", () => {
  assert.deepEqual(validateSpec(splitSpec({ ...SPEC, models: MODELS })).problems, []);
  const bad = validateSpec(splitSpec({ ...SPEC, models: { verify: { best: "x" } } }));
  assert.match(bad.problems[0].message, /models\.verify\.best is not a known key/);
});

// ---- a recorded green gate (#43) --------------------------------------------------------------------

// The verifier runs the gate itself here (gate.roles.verify "pick"; the default "none" gives it none).
const VERIFY_GATES = { gate: { ...SPEC.gate, roles: { verify: "pick" } } };

test("a gate that went green on the tip is read, not re-run, in the waiting verify brief", () => {
  const r = repo(VERIFY_GATES);
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
  const r = repo(VERIFY_GATES);
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
  const r = repo({
    gate: { tiers: [{ name: "full", command: ["sh", "-c", "exit 1"] }], roles: { verify: "pick" } },
  });
  build(lane(r, "start", "T1").json);
  const built = lane(r, "report", "T1");
  assert.equal(lane(r, "gate", "T1").exit, 1);
  assert.match(readFileSync(built.json.brief, "utf8"), /Run the gate as the lane records it/);
});

test("exec start refuses an old gate.command or gate.quick at load, naming gate.tiers, writing nothing", () => {
  const r = repo({
    gate: { command: ["make"], quick: { command: ["make", "q"], only: ["docs/**"] } },
  });
  const res = lane(r, "start", "T1");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /gate\.command replaced by gate\.tiers \(0\.3\): make it the last tier/);
  assert.match(res.stderr, /gate\.quick replaced by gate\.tiers: a tier with "when"/);
  assert.equal(existsSync(join(r.root, ".agentry", "run")), false);
});

// ---- presets: notes rounds, the final, the route snapshot (A47, #49) ----------------------------------

const ledgerBytes = (root, id) =>
  readFileSync(join(root, ".agentry", "run", "process", "ledger", `${id}.json`), "utf8");
const say = (out, text) => writeFileSync(out.reportPath, text);
const NOTES = "Checked.\nN1: rename the helper\nN2: a comment is stale\nused_memories: none\n";
const failWith = (out) => say(out, `${NOTES}Verdict: FAIL\n`);
const notesWith = (out) => say(out, `${NOTES}Verdict: PASS WITH NOTES\n`);
// A builder's fix on the worktree: a commit and a DONE report.
function fixIt(out, file = "fix.txt") {
  commitFile(out.worktree, file, "fixed\n", `fix: ${file}`);
  say(out, "DONE\nfixed\nused_memories: none\n");
}
// T1 built, then judged by `verdict(out)`: returns the verdict step's result.
function judged(r, verdict) {
  const started = lane(r, "start", "T1").json;
  build(started);
  const verify = lane(r, "report", "T1", "--agent", "builder-1").json;
  verdict(verify);
  return lane(r, "verdict", "T1", "--agent", "verifier-1");
}

test("noteRounds 0: PASS WITH NOTES goes on to the gate and closes; the notes stay open; fix exits 2", () => {
  const r = repo({ exec: { noteRounds: 0 } });
  const v = judged(r, notesWith);
  assert.equal(v.json.next, "gate");
  assert.equal(v.json.notes, "notes kept open (exec.noteRounds is 0)");
  assert.deepEqual(ledgerOf(r.root, "T1").openNotes, [
    "N1 rename the helper",
    "N2 a comment is stale",
  ]);
  const before = ledgerBytes(r.root, "T1");
  const fix = lane(r, "fix", "T1", "--notes", "N1");
  assert.equal(fix.exit, 2);
  assert.match(fix.stderr, /0 of 0 notes rounds are used \(exec\.noteRounds is 0/);
  assert.equal(ledgerBytes(r.root, "T1"), before, "a refusal writes nothing");
  assert.equal(lane(r, "gate", "T1").json.next, "close");
  const closed = lane(r, "close", "T1").json;
  assert.match(closed.episode.outcome, /open notes: N1 rename the helper \| N2 a comment is stale/);
  assert.deepEqual(lane(r, "show", "T1").json.openNotes, ledgerOf(r.root, "T1").openNotes);
});

test("noteRounds 1: one notes round is sent, a second is refused naming the key", () => {
  const r = repo({ exec: { noteRounds: 1, final: "never" } });
  const v = judged(r, notesWith);
  assert.match(v.json.notes, /exec fix T1 .*--notes N1,N2$/);
  const fix = lane(r, "fix", "T1", "--notes", "N1").json;
  assert.equal(fix.next, "fix");
  fixIt(fix);
  const recheck = lane(r, "report", "T1").json;
  assert.equal(recheck.next, "recheck");
  say(
    recheck,
    "N1: PASS renamed\nN3: one more thing\nused_memories: none\nVerdict: PASS WITH NOTES\n",
  );
  const again = lane(r, "verdict", "T1").json;
  assert.equal(again.next, "gate");
  assert.equal(again.notes, "notes kept open (exec.noteRounds is 1)");
  // N2 was never sent back and N1 passed: the open notes are N3 and N2.
  assert.deepEqual(ledgerOf(r.root, "T1").openNotes, [
    "N3 one more thing",
    "N2 a comment is stale",
  ]);
  const before = ledgerBytes(r.root, "T1");
  const second = lane(r, "fix", "T1", "--notes", "N3");
  assert.equal(second.exit, 2);
  assert.match(second.stderr, /1 of 1 notes rounds are used \(exec\.noteRounds is 1/);
  assert.equal(ledgerBytes(r.root, "T1"), before);
});

// A lane at its recheck after a FAIL labelled N1 and N2 (`fix` makes the builder's fix round).
function atRecheck(r, fix = fixIt) {
  const v = judged(r, failWith).json;
  assert.equal(v.next, "fix");
  fix(v);
  const recheck = lane(r, "report", "T1").json;
  assert.equal(recheck.next, "recheck");
  return recheck;
}

test("final after-fix: a recheck passing every label sent back on a fast-forward tip closes with no final", () => {
  const r = repo({ exec: { final: "after-fix" } });
  const recheck = atRecheck(r);
  const brief = readFileSync(recheck.brief, "utf8");
  assert.match(brief, /For each note sent back \(N1, N2\), write one line/);
  say(recheck, "- N1: PASS renamed\nn2: pass fixed\nused_memories: none\nVerdict: PASS\n");
  const v = lane(r, "verdict", "T1").json;
  assert.equal(v.next, "gate");
  const round = ledgerOf(r.root, "T1").rounds.at(-1);
  assert.deepEqual([round.covered, round.onlyFixCommits], [true, true]);
  assert.equal(lane(r, "gate", "T1").json.next, "close");
});

test("final after-fix: a label missing, fenced, in prose, or with a FAIL line too sends a final", () => {
  const reports = {
    missing: "N1: PASS renamed\n",
    fenced: "N1: PASS renamed\n```\nN2: PASS fixed\n```\n",
    prose: "N1: PASS renamed\nN2 passes now\n",
    both: "N1: PASS renamed\nN2: PASS fixed\nN2: FAIL still stale\n",
  };
  for (const [why, lines] of Object.entries(reports)) {
    const r = repo({ exec: { final: "after-fix" } });
    say(atRecheck(r), `${lines}used_memories: none\nVerdict: PASS\n`);
    const v = lane(r, "verdict", "T1").json;
    assert.equal(v.next, "final", why);
    assert.match(v.why, /did not pass every note sent back/, why);
  }
});

test("final after-fix: a rewritten tip, or one with a merge commit since the verdict, sends a final", () => {
  const amend = (out) => {
    // The fix rewrites the verified commit: the old tip is no ancestor of the new one.
    writeFileSync(join(out.worktree, "out.txt"), "remade\n");
    git(out.worktree, "commit", "-q", "-a", "--amend", "-m", "feat: add out.txt again");
    say(out, "DONE\nfixed\nused_memories: none\n");
  };
  const merged = (out) => {
    git(out.worktree, "checkout", "-q", "-b", "side");
    commitFile(out.worktree, "side.txt", "side\n", "feat: side");
    git(out.worktree, "checkout", "-q", "agentry/T1");
    git(out.worktree, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    git(out.worktree, "branch", "-q", "-D", "side");
    say(out, "DONE\nfixed\nused_memories: none\n");
  };
  for (const [why, fix] of Object.entries({ amend, merged })) {
    const r = repo({ exec: { final: "after-fix" } });
    say(atRecheck(r, fix), "N1: PASS ok\nN2: PASS ok\nused_memories: none\nVerdict: PASS\n");
    const v = lane(r, "verdict", "T1").json;
    assert.equal(v.next, "final", why);
    assert.match(v.why, /more than fix commits/, why);
    assert.equal(ledgerOf(r.root, "T1").rounds.at(-2).onlyFixCommits, false, why);
  }
});

test("a mid-lane edit to strict changes the notes cap at the next call; verify, final and rebase stay fixed", () => {
  const r = repo({ exec: { noteRounds: 1, final: "never" } });
  const started = lane(r, "start", "T1");
  assert.deepEqual(ledgerOf(r.root, "T1").route, {
    verify: "all",
    flagged: false,
    preset: "standard",
    noteRounds: 1,
    final: "never",
    rebase: "recheck",
  });
  build(started.json);
  // Uncommitted, and no guard or gate key changes: strict, with no notes rounds.
  writeSpec(join(r.root, ".agentry"), { ...SPEC, exec: { preset: "strict", noteRounds: 0 } });
  const verify = lane(r, "report", "T1").json;
  assert.equal(verify.next, "verify");
  notesWith(verify);
  const v = lane(r, "verdict", "T1").json;
  assert.equal(v.notes, "notes kept open (exec.noteRounds is 0)");
  const capped = lane(r, "fix", "T1", "--notes", "N1");
  assert.equal(capped.exit, 2);
  assert.match(
    capped.stderr,
    /0 of 0 notes rounds are used \(exec\.noteRounds is 0; .*\) → raise exec\.noteRounds, or send it back on your word: .*exec fix T1 .*--owner "<the change>"/,
  );
  const shown = lane(r, "show", "T1").json;
  assert.equal(
    shown["route fixed at start"],
    "standard · verify all · notes 0 (live) · final never · rebase recheck",
  );
  assert.equal(shown.workflow.preset, "strict");
  // Raised: the next call reads it, while final stays the start's "never" (strict says "always").
  writeSpec(join(r.root, ".agentry"), { ...SPEC, exec: { preset: "strict", noteRounds: 2 } });
  const fix = lane(r, "fix", "T1", "--notes", "N1").json;
  assert.equal(fix.next, "fix");
  fixIt(fix);
  const recheck = lane(r, "report", "T1").json;
  say(recheck, "N1: PASS renamed\nused_memories: none\nVerdict: PASS\n");
  assert.equal(lane(r, "verdict", "T1").json.next, "gate", "no final: the route fixed it at never");
});

test("exec start and show print the workflow line for a file with one override; --json the object", () => {
  const r = repo({ exec: { final: "never" } });
  const text = lane(r, "start", "T1", "--text");
  assert.match(
    text.stdout,
    /^workflow: standard · verify all · notes 1 · final never \(set\) · rebase recheck · gate build pick, verify none, merge pick$/m,
  );
  const shown = lane(r, "show", "T1");
  assert.equal(shown.json.workflow.set.join(), "exec.final");
  assert.deepEqual(shown.json.workflow.exec, {
    verify: "all",
    noteRounds: 1,
    final: "never",
    rebase: "recheck",
  });
  assert.match(
    lane(r, "show", "T1", "--text").stdout,
    /^route fixed at start: standard · verify all/m,
  );
});

test("show says when the route fixed at start differs from what the workflow file says now", () => {
  const r = repo();
  lane(r, "start", "T1");
  writeSpec(join(r.root, ".agentry"), { ...SPEC, exec: { verify: "flagged" } });
  assert.equal(
    lane(r, "show", "T1").json.route,
    "all (fixed at start; workflow.json now says flagged)",
  );
});

// ---- reverify, the flag field, the idle threshold (R1c-9 N4, N5) ------------------------------------

// T1 built under exec.verify none: gated and closed with no verifier.
function gateClosed(r) {
  build(lane(r, "start", "T1").json);
  assert.equal(lane(r, "report", "T1").json.next, "gate");
  assert.equal(lane(r, "gate", "T1").json.next, "close");
}

test("reverify on a gate-closed lane dispatches a fresh verifier, then the usual rows", () => {
  const r = repo({ exec: { verify: "none" } });
  gateClosed(r);
  const re = lane(r, "reverify", "T1").json;
  assert.equal(re.next, "verify");
  assert.deepEqual([re.mode, re.role, re.dispatch.agent], ["fresh", "verify", "verifier"]);
  judge(re, "PASS");
  const v = lane(r, "verdict", "T1").json;
  assert.equal(v.next, "close", "the gate is green on this tip already");
  assert.equal(status(r.root, "T1"), "verify");
});

test("reverify on a lane a verifier closed, or one not closed, exits 2 with the ledger as it was", () => {
  const r = repo();
  const started = lane(r, "start", "T1").json;
  let before = ledgerBytes(r.root, "T1");
  assert.equal(lane(r, "reverify", "T1").exit, 2);
  assert.equal(ledgerBytes(r.root, "T1"), before);
  build(started);
  judge(lane(r, "report", "T1").json, "PASS");
  lane(r, "verdict", "T1");
  lane(r, "gate", "T1");
  before = ledgerBytes(r.root, "T1");
  const res = lane(r, "reverify", "T1");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /a verifier closed T1 \(PASS\)/);
  assert.equal(ledgerBytes(r.root, "T1"), before);
});

test("exec.flagField urgent: the route keys on that field", () => {
  const spec = structuredClone(SPEC);
  const { flag, ...rest } = spec.kinds.task.fields;
  spec.kinds.task.fields = { ...rest, urgent: { ...flag, column: "Flag" } };
  const r = repo({ ...spec, exec: { verify: "flagged", flagField: "urgent" } });
  // T2 has its Flag column set: under the urgent field it is flagged, so a verifier reads it.
  const two = lane(r, "start", "T2");
  assert.match(two.json.route, /this item is flagged/);
  build(two.json);
  assert.equal(lane(r, "report", "T2").json.next, "verify");
  const one = lane(r, "start", "T1");
  build(one.json);
  assert.equal(lane(r, "report", "T1").json.next, "gate");
});

test("exec.idleMinutes 5 flags a lane quiet for 6 minutes; the default 20 does not", () => {
  const quiet = (r) => {
    const started = lane(r, "start", "T1").json;
    const file = join(r.root, ".agentry", "run", "process", "ledger", "T1.json");
    const l = JSON.parse(readFileSync(file, "utf8"));
    const old = new Date(Date.now() - 6 * 60_000);
    const older = new Date(old.getTime() - 60_000); // the dispatch and the files: before the commit
    l.rounds.at(-1).at = older.toISOString();
    writeFileSync(file, JSON.stringify(l, null, 2));
    spawnSync("git", ["-C", started.worktree, "commit", "-q", "--amend", "--no-edit"], {
      env: { ...gitEnv, GIT_COMMITTER_DATE: old.toISOString() },
    });
    for (const f of git(started.worktree, "ls-files").split("\n"))
      if (f) utimesSync(join(started.worktree, f), older, older);
    return lane(r, "show", "T1").json.idle;
  };
  const idle = quiet(repo({ exec: { idleMinutes: 5 } }));
  assert.ok(idle && idle.minutes >= 6, JSON.stringify(idle));
  assert.equal(idle.newest, "commit");
  assert.equal(quiet(repo()), undefined);
});

test("the idle text names the last commit when it is the newest change, no file changed for the dispatch", () => {
  const head = (newest, file = null) =>
    idleHead("T1", { minutes: 25, lastChange: "2026-11-03T10:00:00.000Z", file, newest });
  assert.match(head("commit"), /\(the last commit\) → check the builder$/);
  assert.match(head("dispatch"), /\(no file changed\) → check the builder$/);
  assert.match(head("file", "a.txt"), /\(a\.txt\) → check the builder$/);
});

// ---- the land conflict, the rebase and the resolution recheck (A48) -----------------------------------

const ALLOW = { guard: { allow: ["notes/**"] } };
const land = ({ root, home }) =>
  spawnSync("node", [LANE, "merge", "T1", "--message", "docs(board): land T1", "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home, NO_COLOR: "1" },
  });
// T1 built (out.txt and notes/shared.md on its branch), verified PASS and gated green: closed.
function closedT1(r) {
  const started = lane(r, "start", "T1").json;
  commitFile(started.worktree, "notes/shared.md", "branch side\n", "docs: branch side");
  build(started);
  judge(lane(r, "report", "T1", "--agent", "builder-1").json, "PASS");
  assert.equal(lane(r, "verdict", "T1").json.next, "gate");
  assert.equal(lane(r, "gate", "T1").json.next, "close");
  return started;
}
// The builder rebases in the worktree: a conflict on notes/shared.md is resolved keeping both sides.
function rebaseBy(out, { finish = true } = {}) {
  const res = spawnSync("git", ["-C", out.worktree, "rebase", "main"], {
    env: gitEnv,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    writeFileSync(join(out.worktree, "notes", "shared.md"), "main side\nbranch side\n");
    git(out.worktree, "add", "notes/shared.md");
    if (finish)
      spawnSync("git", ["-C", out.worktree, "rebase", "--continue"], {
        env: { ...gitEnv, GIT_EDITOR: "true" },
      });
  }
  writeFileSync(out.reportPath, "DONE\nrebased onto main\nused_memories: none\n");
}

test("a land conflict names lane exec rebase; the resolved conflict sends resolve with the range-diff", () => {
  const r = repo(ALLOW);
  closedT1(r);
  commitFile(r.root, "notes/shared.md", "main side\n", "docs: main side");
  const pre = git(r.root, "rev-parse", "HEAD");
  const landed = land(r);
  assert.equal(landed.status, 1, landed.stdout);
  assert.match(landed.stdout, /next: (agentry )?lane exec rebase T1$/m);
  assert.equal(git(r.root, "rev-parse", "HEAD"), pre);
  const rebase = lane(r, "rebase", "T1").json;
  assert.equal(rebase.next, "rebase");
  assert.deepEqual([rebase.role, rebase.mode, rebase.agent], ["build", "resume", "builder-1"]);
  assert.match(readFileSync(rebase.brief, "utf8"), /git rebase main` \(no `-i`\)/);
  const entry = ledgerOf(r.root, "T1").rebases[0];
  assert.ok(entry.fromBase && entry.fromTip && entry.toTip === undefined);
  rebaseBy(rebase);
  const resolve = lane(r, "report", "T1").json;
  assert.equal(resolve.next, "resolve");
  assert.deepEqual([resolve.role, resolve.mode], ["verify", "fresh"]);
  const diff = join(r.root, ".agentry", "run", "process", "runs", "T1", "logs", "range-diff-1.txt");
  assert.ok(existsSync(diff));
  assert.match(
    readFileSync(resolve.brief, "utf8"),
    new RegExp(`is in ${diff.replace(/[.]/g, "\\.")}`),
  );
  const l = ledgerOf(r.root, "T1");
  assert.equal(l.base, pre, "the base is the new merge base with main");
  assert.equal(l.rebases[0].changed, true);
  // a resolve FAIL stops the lane
  judge(resolve, "FAIL");
  const failed = lane(r, "verdict", "T1");
  assert.equal(failed.exit, 1);
  assert.equal(failed.json.reason, "the conflict resolution failed its check");
});

test("a resolve PASS goes to the gate and closes on the new tip; the land then goes through", () => {
  const r = repo(ALLOW);
  closedT1(r);
  commitFile(r.root, "notes/shared.md", "main side\n", "docs: main side");
  assert.equal(land(r).status, 1);
  rebaseBy(lane(r, "rebase", "T1").json);
  const resolve = lane(r, "report", "T1").json;
  judge(resolve, "PASS");
  assert.equal(lane(r, "verdict", "T1").json.next, "gate");
  assert.equal(lane(r, "gate", "T1").json.next, "close");
  const tip = git(r.root, "rev-parse", "agentry/T1");
  assert.equal(ledgerOf(r.root, "T1").closedTip, tip);
  const landed = land(r);
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
});

test("a clean rebase (every pair =) goes to the gate; rebase gate goes to the gate on a changed one", () => {
  const clean = repo(ALLOW);
  closedT1(clean);
  commitFile(clean.root, "notes/other.md", "other\n", "docs: other");
  rebaseBy(lane(clean, "rebase", "T1").json);
  const gated = lane(clean, "report", "T1").json;
  assert.equal(gated.next, "gate");
  assert.match(gated.why, /the rebase changed no commit/);
  assert.equal(ledgerOf(clean.root, "T1").rebases[0].changed, false);
  assert.equal(lane(clean, "gate", "T1").json.next, "close");
  const r = repo({ ...ALLOW, exec: { rebase: "gate" } });
  closedT1(r);
  commitFile(r.root, "notes/shared.md", "main side\n", "docs: main side");
  rebaseBy(lane(r, "rebase", "T1").json);
  const out = lane(r, "report", "T1").json;
  assert.equal(out.next, "gate");
  assert.match(out.why, /exec\.rebase is "gate"/);
});

test("a rebase report with a rebase still in progress is refused, naming the worktree", () => {
  const r = repo(ALLOW);
  const started = closedT1(r);
  commitFile(r.root, "notes/shared.md", "main side\n", "docs: main side");
  rebaseBy(lane(r, "rebase", "T1").json, { finish: false });
  const before = ledgerBytes(r.root, "T1");
  const res = lane(r, "report", "T1");
  assert.equal(res.exit, 2);
  assert.match(
    res.stderr,
    new RegExp(`a rebase is still in progress in the worktree ${started.worktree}`),
  );
  assert.equal(ledgerBytes(r.root, "T1"), before);
});

test("exec rebase killed after its rebases[] entry reruns on it: one entry, one dispatch", () => {
  const r = repo(ALLOW);
  closedT1(r);
  const file = join(r.root, ".agentry", "run", "process", "ledger", "T1.json");
  const l = JSON.parse(readFileSync(file, "utf8"));
  const tip = git(r.root, "rev-parse", "agentry/T1");
  l.rebases = [{ fromBase: l.base, fromTip: tip, at: "2026-11-03T10:00:00.000Z" }];
  writeFileSync(file, JSON.stringify(l, null, 2)); // what a run killed before its dispatch left
  const rounds = l.rounds.length;
  const first = lane(r, "rebase", "T1").json;
  assert.equal(first.next, "rebase");
  const again = lane(r, "rebase", "T1");
  assert.equal(again.exit, 0, "a rerun with the round out prints it again");
  const after = ledgerOf(r.root, "T1");
  assert.equal(after.rebases.length, 1);
  assert.equal(after.rebases[0].at, "2026-11-03T10:00:00.000Z");
  assert.equal(after.rounds.length, rounds + 1);
});

test("exec rebase on a lane that is not verified exits 2 with the ledger byte-identical", () => {
  const r = repo();
  build(lane(r, "start", "T1").json);
  lane(r, "report", "T1");
  const before = ledgerBytes(r.root, "T1");
  const res = lane(r, "rebase", "T1");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /rebase is for a verified lane: T1 is verifying/);
  assert.equal(ledgerBytes(r.root, "T1"), before);
});

test("a branch already rebased onto main past closedTip is recorded with no builder round", () => {
  const r = repo(ALLOW);
  const started = closedT1(r);
  const closedTip = ledgerOf(r.root, "T1").closedTip;
  commitFile(r.root, "notes/other.md", "other\n", "docs: other");
  git(started.worktree, "rebase", "-q", "main");
  const rounds = ledgerOf(r.root, "T1").rounds.length;
  const res = lane(r, "rebase", "T1").json;
  assert.equal(res.next, "gate");
  assert.match(res.rangeDiff, /range-diff-1\.txt$/);
  const l = ledgerOf(r.root, "T1");
  assert.equal(l.rounds.length, rounds, "no builder round");
  assert.equal(l.rebases[0].fromTip, closedTip);
  assert.equal(l.rebases[0].toTip, git(r.root, "rev-parse", "agentry/T1"));
});

test("each rebase writes its own range-diff file", () => {
  const r = repo(ALLOW);
  closedT1(r);
  for (const n of [1, 2]) {
    commitFile(r.root, `notes/other-${n}.md`, "other\n", `docs: other ${n}`);
    rebaseBy(lane(r, "rebase", "T1").json);
    assert.equal(lane(r, "report", "T1").json.next, "gate");
    assert.equal(lane(r, "gate", "T1").json.next, "close");
  }
  const logs = join(r.root, ".agentry", "run", "process", "runs", "T1", "logs");
  assert.ok(
    existsSync(join(logs, "range-diff-1.txt")) && existsSync(join(logs, "range-diff-2.txt")),
  );
  assert.equal(ledgerOf(r.root, "T1").rebases.length, 2);
});

test("a resolve verdict on a moved tip voids and sends resolve again", () => {
  const r = repo(ALLOW);
  closedT1(r);
  commitFile(r.root, "notes/shared.md", "main side\n", "docs: main side");
  rebaseBy(lane(r, "rebase", "T1").json);
  const resolve = lane(r, "report", "T1").json;
  commitFile(resolve.worktree, "late.txt", "late\n", "fix: late");
  judge(resolve, "PASS");
  const v = lane(r, "verdict", "T1").json;
  assert.equal(v.verdict, "void");
  assert.equal(v.next, "resolve");
  assert.equal(v.mode, "fresh");
});

test("a land on a branch moved past closedTip is refused with the pointer, main untouched", () => {
  const r = repo();
  const started = lane(r, "start", "T1").json;
  build(started);
  judge(lane(r, "report", "T1").json, "PASS");
  lane(r, "verdict", "T1");
  lane(r, "gate", "T1");
  const closedTip = ledgerOf(r.root, "T1").closedTip;
  commitFile(started.worktree, "extra.txt", "extra\n", "feat: extra");
  const pre = git(r.root, "rev-parse", "HEAD");
  const dirty = git(r.root, "status", "--porcelain");
  const boardBefore = readFileSync(join(r.root, "plan", "BOARD.md"), "utf8");
  const before = ledgerBytes(r.root, "T1");
  const res = land(r);
  assert.equal(res.status, 2, res.stdout);
  assert.match(
    res.stdout + res.stderr,
    new RegExp(
      `agentry/T1 moved since the lane closed on ${closedTip.slice(0, 7)}: (agentry )?lane exec rebase T1`,
    ),
  );
  assert.equal(git(r.root, "rev-parse", "HEAD"), pre);
  assert.equal(git(r.root, "status", "--porcelain"), dirty);
  assert.equal(readFileSync(join(r.root, "plan", "BOARD.md"), "utf8"), boardBefore);
  assert.equal(ledgerBytes(r.root, "T1"), before);
});

test("merge on a flagged lane closed with no verifier names lane exec reverify", () => {
  const r = repo({ exec: { verify: "none" } });
  build(lane(r, "start", "T2").json); // T2 is flagged: it has a verifier, so close one by hand
  const file = join(r.root, ".agentry", "run", "process", "ledger", "T2.json");
  lane(r, "report", "T2");
  const l = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(
    file,
    JSON.stringify({ ...l, rounds: l.rounds.slice(0, 1), state: "verified", next: "merge" }),
  );
  const res = spawnSync("node", [LANE, "merge", "T2", "--preflight", "--root", r.root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: r.home, NO_COLOR: "1" },
  });
  assert.equal(res.status, 2);
  assert.match(
    res.stdout + res.stderr,
    /a flagged item lands only after a verdict\n(.*\n)*next: (agentry )?lane exec reverify T2$/m,
  );
});

// ---- every pair the range-diff can show (A48; the failure bar's `<`, `>` and uncomputable cases) ------

const rangeDiffOf = (root, n = 1) =>
  readFileSync(
    join(root, ".agentry", "run", "process", "runs", "T1", "logs", `range-diff-${n}.txt`),
    "utf8",
  );
const rebased = (out) =>
  writeFileSync(out.reportPath, "DONE\nrebased onto main\nused_memories: none\n");

test("a rebase that adds a commit (a > pair) goes to resolve", () => {
  const r = repo(ALLOW);
  const started = closedT1(r);
  commitFile(r.root, "notes/other.md", "other\n", "docs: other");
  const rebase = lane(r, "rebase", "T1").json;
  git(started.worktree, "rebase", "-q", "main");
  commitFile(started.worktree, "extra.txt", "extra\n", "feat: add extra");
  rebased(rebase);
  const out = lane(r, "report", "T1").json;
  assert.match(rangeDiffOf(r.root), /^-:\s+-+ > \d+:/m);
  assert.equal(out.next, "resolve");
  assert.equal(ledgerOf(r.root, "T1").rebases[0].changed, true);
});

test("a rebase that drops a commit main already holds (a < pair) goes to resolve", () => {
  const r = repo(ALLOW);
  const started = closedT1(r);
  // main gets the very patch of the branch's first commit: the rebase drops it as already upstream
  commitFile(r.root, "notes/shared.md", "branch side\n", "docs: branch side on main");
  const rebase = lane(r, "rebase", "T1").json;
  git(started.worktree, "rebase", "-q", "main");
  rebased(rebase);
  const out = lane(r, "report", "T1").json;
  assert.match(rangeDiffOf(r.root), /^\d+:\s+[0-9a-f]+ < -:/m);
  assert.equal(out.next, "resolve");
});

test("a range-diff git cannot compute goes to resolve, recorded as changed, its file saying why", () => {
  const r = repo(ALLOW);
  const started = closedT1(r);
  commitFile(r.root, "notes/other.md", "other\n", "docs: other");
  const rebase = lane(r, "rebase", "T1").json;
  const file = join(r.root, ".agentry", "run", "process", "ledger", "T1.json");
  const l = JSON.parse(readFileSync(file, "utf8"));
  l.rebases[0].fromBase = "0123456789abcdef0123456789abcdef01234567"; // an object git does not have
  writeFileSync(file, JSON.stringify(l, null, 2));
  git(started.worktree, "rebase", "-q", "main");
  rebased(rebase);
  const out = lane(r, "report", "T1").json;
  assert.equal(out.next, "resolve");
  assert.match(rangeDiffOf(r.root), /^git range-diff failed/);
  assert.equal(ledgerOf(r.root, "T1").rebases[0].changed, true);
});

// A closed T1 whose rebase resolved a conflict on notes/shared.md: its resolve round out.
function resolvingT1(r) {
  closedT1(r);
  commitFile(r.root, "notes/shared.md", "main side\n", "docs: main side");
  rebaseBy(lane(r, "rebase", "T1").json);
  const resolve = lane(r, "report", "T1").json;
  assert.equal(resolve.next, "resolve");
  return resolve;
}

test("a resolve PASS WITH NOTES offers no notes round, writes no board cell, and fix --notes is refused", () => {
  const r = repo(ALLOW);
  const resolve = resolvingT1(r);
  const board = readFileSync(join(r.root, "plan", "BOARD.md"), "utf8");
  say(
    resolve,
    "N1: the merged line order could be nicer\nused_memories: none\nVerdict: PASS WITH NOTES\n",
  );
  const v = lane(r, "verdict", "T1");
  assert.equal(v.exit, 0, v.stderr);
  assert.equal(v.json.next, "gate");
  assert.equal(v.json.notes, undefined, "no notes line");
  assert.equal(readFileSync(join(r.root, "plan", "BOARD.md"), "utf8"), board, "board untouched");
  const before = ledgerBytes(r.root, "T1");
  assert.equal(lane(r, "fix", "T1", "--notes", "N1").exit, 2);
  assert.equal(ledgerBytes(r.root, "T1"), before);
  assert.equal(lane(r, "gate", "T1").json.next, "close");
  assert.equal(ledgerOf(r.root, "T1").closedTip, git(r.root, "rev-parse", "agentry/T1"));
});

test("exec rebase on a lane a resolve FAIL stopped exits 2 with the ledger byte-identical", () => {
  const r = repo(ALLOW);
  const resolve = resolvingT1(r);
  judge(resolve, "FAIL");
  assert.equal(lane(r, "verdict", "T1").exit, 1);
  const before = ledgerBytes(r.root, "T1");
  const again = lane(r, "rebase", "T1");
  assert.equal(again.exit, 2);
  assert.match(again.stderr, /rebase is for a verified lane: T1 is stopped/);
  assert.equal(ledgerBytes(r.root, "T1"), before);
});

test("two lanes on one file: the second's land conflicts, rebases past the first's land, resolves and lands", () => {
  // No guard.allow: main moves only by T2's land, which the rebase report's guard counts as a landed lane.
  const r = repo();
  const closed = (id, text) => {
    const out = lane(r, "start", id).json;
    commitFile(out.worktree, "out.txt", text, `feat: ${id} out.txt`);
    writeFileSync(out.reportPath, "DONE\nadded out.txt\nused_memories: none\n");
    judge(lane(r, "report", id, "--agent", `builder-${id}`).json, "PASS");
    lane(r, "verdict", id);
    assert.equal(lane(r, "gate", id).json.next, "close", id);
    return out;
  };
  const one = closed("T1", "T1 side\n");
  closed("T2", "T2 side\n");
  const merge = (id) =>
    spawnSync(
      "node",
      [LANE, "merge", id, "--message", `docs(board): land ${id}`, "--root", r.root],
      {
        encoding: "utf8",
        env: { ...gitEnv, HOME: r.home, NO_COLOR: "1" },
      },
    );
  const two = merge("T2");
  assert.equal(two.status, 0, two.stdout + two.stderr);
  const first = merge("T1");
  assert.equal(first.status, 1, first.stdout);
  assert.match(first.stdout, /next: (agentry )?lane exec rebase T1$/m);
  const rebase = lane(r, "rebase", "T1");
  assert.equal(rebase.exit, 0, rebase.stderr);
  assert.equal(rebase.json.agent, "builder-T1");
  assert.notEqual(
    spawnSync("git", ["-C", one.worktree, "rebase", "main"], { env: gitEnv }).status,
    0,
  );
  writeFileSync(join(one.worktree, "out.txt"), "T2 side\nT1 side\n");
  git(one.worktree, "add", "out.txt");
  spawnSync("git", ["-C", one.worktree, "rebase", "--continue"], {
    env: { ...gitEnv, GIT_EDITOR: "true" },
  });
  rebased(rebase.json);
  const resolve = lane(r, "report", "T1");
  assert.equal(resolve.json?.next, "resolve", `${resolve.stderr}${resolve.json?.reason ?? ""}`);
  judge(resolve.json, "PASS");
  assert.equal(lane(r, "verdict", "T1").json.next, "gate");
  assert.equal(lane(r, "gate", "T1").json.next, "close");
  const again = merge("T1");
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(readFileSync(join(r.root, "out.txt"), "utf8"), "T2 side\nT1 side\n");
});

// ---- the owner sends a verified lane back (field 77) -----------------------------------------------

const ISO = "\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z";
// The owner's change made in the worktree, and the builder's report on it.
function ownerBuild(out) {
  commitFile(out.worktree, "owner.txt", "changed\n", "feat: the owner's change");
  writeFileSync(out.reportPath, "DONE\nmade the owner's change\nused_memories: none\n");
}

test("fix --owner on a verified lane: one round for its builder quoting the change, then a recheck by the last verifier", () => {
  const r = repo();
  const started = lane(r, "start", "T1");
  build(started.json);
  const verify = lane(r, "report", "T1", "--agent", "builder-1").json;
  judge(verify, "PASS");
  assert.equal(lane(r, "verdict", "T1", "--agent", "verifier-1").json.next, "gate");
  assert.equal(lane(r, "gate", "T1").json.next, "close");

  const sent = lane(r, "fix", "T1", "--owner", "Rename the button\nto Save");
  assert.equal(sent.exit, 0, sent.stderr);
  assert.deepEqual(
    [sent.json.next, sent.json.state, sent.json.mode, sent.json.agent],
    ["fix", "fixing", "resume", "builder-1"],
  );
  const brief = readFileSync(sent.json.brief, "utf8");
  assert.match(
    brief,
    new RegExp(
      `## The owner's change\\n\\nThe owner sent the verified lane back at ${ISO}:\\n\\n> Rename the button\\n> to Save\\n\\nMake exactly that change`,
    ),
  );
  assert.doesNotMatch(brief, /## Fix list/, "no verifier's FAIL to fix");
  const fixes = ledgerOf(r.root, "T1").ownerFixes;
  assert.equal(fixes.length, 1);
  assert.deepEqual([fixes[0].note, fixes[0].round], ["Rename the button\nto Save", 3]);
  assert.match(fixes[0].at, new RegExp(`^${ISO}$`));
  assert.equal(ledgerOf(r.root, "T1").rounds.at(-1).n, 3);

  ownerBuild(sent.json);
  const recheck = lane(r, "report", "T1", "--agent", "builder-1").json;
  assert.deepEqual(
    [recheck.next, recheck.mode, recheck.agent],
    ["recheck", "resume", "verifier-1"],
  );
  const recheckBrief = readFileSync(recheck.brief, "utf8");
  assert.match(
    recheckBrief,
    /## The owner's change\n[\s\S]*> to Save\n\nThe builder's round you check made that change/,
  );
  assert.match(recheckBrief, /`owner: PASS <evidence>` or `owner: FAIL <evidence>`/);
  assert.match(recheckBrief, /For each note sent back \(owner\)/);
  // owner: PASS covers the one note sent back, so under final "after-fix" no final follows.
  writeFileSync(
    recheck.reportPath,
    "Rechecked.\nowner: PASS the button reads Save\nused_memories: none\nVerdict: PASS\n",
  );
  assert.equal(lane(r, "verdict", "T1").json.next, "gate");
  assert.equal(ledgerOf(r.root, "T1").rounds.at(-1).covered, true);
  assert.equal(lane(r, "gate", "T1").json.next, "close");
  assert.match(lane(r, "close", "T1").json.episode.outcome, /; owner fixes: 1/);
});

test("a recheck after an owner fix with no owner: PASS line, or an owner: FAIL one, is not covered: a final follows", () => {
  for (const line of ["", "owner: FAIL still reads Submit\n"]) {
    const r = repo();
    const started = lane(r, "start", "T1");
    build(started.json);
    judge(lane(r, "report", "T1").json, "PASS");
    lane(r, "verdict", "T1");
    lane(r, "gate", "T1");
    const sent = lane(r, "fix", "T1", "--owner", "rename it").json;
    ownerBuild(sent);
    const recheck = lane(r, "report", "T1").json;
    writeFileSync(recheck.reportPath, `Rechecked.\n${line}used_memories: none\nVerdict: PASS\n`);
    assert.equal(lane(r, "verdict", "T1").json.next, "final", JSON.stringify(line));
    assert.equal(ledgerOf(r.root, "T1").rounds.at(-2).covered, false, "the recheck round");
  }
});

test("fix --owner under a route that skipped the verifier: the gate on the new tip, then close; a fresh builder when none can be resumed", () => {
  const r = repo({ exec: { verify: "flagged" } });
  const started = lane(r, "start", "T1");
  build(started.json);
  assert.equal(lane(r, "report", "T1").json.next, "gate");
  assert.equal(lane(r, "gate", "T1").json.next, "close");
  assert.equal(lane(r, "close", "T1").json.next, "merge");
  const before = ledgerOf(r.root, "T1").closedTip;

  const sent = lane(r, "fix", "T1", "--owner", "one more line");
  assert.equal(sent.exit, 0, sent.stderr);
  assert.deepEqual([sent.json.next, sent.json.mode], ["fix", "fresh"]);
  ownerBuild(sent.json);
  const built = lane(r, "report", "T1").json;
  assert.equal(built.next, "gate", "no verifier: the gate checks the new tip");
  const tip = git(sent.json.worktree, "rev-parse", "HEAD");
  assert.notEqual(tip, before);
  assert.equal(ledgerOf(r.root, "T1").gateTip, tip);
  assert.equal(lane(r, "gate", "T1").json.next, "close");
  assert.equal(ledgerOf(r.root, "T1").closedTip, tip);
});

test("fix --owner is refused with no text, with --notes, while a builder is out, and on a merged lane", () => {
  const r = repo();
  const started = lane(r, "start", "T1");
  const both = lane(r, "fix", "T1", "--owner", "x", "--notes", "N1");
  assert.equal(both.exit, 2);
  assert.match(both.stderr, /fix needs --notes N1,N3 or --owner "<the change>", one of them/);
  const out = lane(r, "fix", "T1", "--owner", "x");
  assert.equal(out.exit, 2);
  assert.match(out.stderr, /a builder is out on round 1 \(build\): report it first/);
  build(started.json);
  judge(lane(r, "report", "T1").json, "PASS");
  lane(r, "verdict", "T1");
  lane(r, "gate", "T1");
  const blank = lane(r, "fix", "T1", "--owner", "  ");
  assert.equal(blank.exit, 2);
  assert.match(blank.stderr, /--owner needs the owner's change/);
  const file = join(r.root, ".agentry", "run", "process", "ledger", "T1.json");
  writeFileSync(file, JSON.stringify({ ...ledgerOf(r.root, "T1"), state: "merged", next: null }));
  const merged = lane(r, "fix", "T1", "--owner", "x");
  assert.equal(merged.exit, 2);
  assert.match(merged.stderr, /T1 is merged: the owner's change is a new task/);
  assert.equal(ledgerOf(r.root, "T1").ownerFixes, undefined);
});

test("a Model bullet inside a code fence is not the contract's model (R1d-22 N4)", () => {
  const spec = { models: { build: "sonnet", verify: { default: "haiku" } } };
  const fenced =
    "- **Owns:** `a.txt`\n\n```md\n- **Model:** opus\n- **Model (verify):** opus\n```\n";
  assert.deepEqual(modelFor(spec, "build", { contract: fenced }), {
    model: "sonnet",
    from: "models.build",
  });
  assert.deepEqual(modelFor(spec, "verify", { contract: fenced }), {
    model: "haiku",
    from: "models.verify.default",
  });
  const after = `${fenced}- **Model:** opus\n`;
  assert.deepEqual(modelFor(spec, "build", { contract: after }), {
    model: "opus",
    from: "contract",
  });
});

test("models.verify.ui is unused only when verify.flagged is set too (R1d-22 N1)", () => {
  // Under a flagged route a flagged UI item takes verify.flagged first, else verify.ui.
  const ui = { verify: { ui: "ui-m" } };
  const both = { verify: { ui: "ui-m", flagged: "flag-m" } };
  assert.deepEqual(modelFor({ models: ui }, "verify", { flagged: true, ui: true }), {
    model: "ui-m",
    from: "models.verify.ui",
  });
  assert.equal(unusedUiModel(ui, "flagged"), null);
  assert.match(
    unusedUiModel(both, "flagged"),
    /^! models\.verify\.ui is unused: exec\.verify is flagged/,
  );
  assert.match(unusedUiModel(both, "none"), /exec\.verify is none/);
  assert.equal(unusedUiModel(both, "all"), null);
  const r = repo({ exec: { verify: "flagged" }, models: ui });
  assert.doesNotMatch(lane(r, "start", "T1").json.route, /unused/);
});
