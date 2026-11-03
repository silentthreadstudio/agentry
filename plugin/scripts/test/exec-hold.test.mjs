// Tests for a lane built in steps with the owner's holds (fields 47, 48, 54): `lane exec` on temp git
// repos. A contract's Steps part sets the runs; a run that ends at `→ owner OK` holds the lane; `hold`
// and `resume` write the ledger only, so the board never moves at a hold; a held or parked lane is no
// writer, but its resume is one; main must be as the lane left it when the owner answers.
// Run: node --test plugin/scripts/test/exec-hold.test.mjs
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
| T1   | todo   |         |
| T2   | todo   |         |
| T3   | todo   |         |
| T4   | todo   |         |
`;
const TASKS_MD = `# Tasks

### T1 · Two steps

- **Owns:** \`one.txt\`, \`two.txt\`
- **Steps:**
  1. Write one.txt → owner OK
  2. Write two.txt
- **Acceptance:**
  - Step 1: one.txt exists
  - two.txt exists

### T2 · A gap

- **Owns:** \`gap.txt\`
- **Steps:**
  1. First
  3. Third

### T3 · No steps

- **Owns:** \`three.txt\`. Accept: three.txt exists.

### T4 · Another

- **Owns:** \`four.txt\`. Accept: four.txt exists.
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
const ISO = "\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z";

test("a two-step lane holds for the owner after step 1, resumes its builder on step 2, then one verifier reads it all", () => {
  const r = repo({ lanes: { maxWriters: 1 } });
  let out = lane(r, "start", "T1").json;
  assert.equal(out.steps, "1. Write one.txt → owner OK\n2. Write two.txt");
  const first = readFileSync(out.brief, "utf8");
  assert.match(
    first,
    /## This round: step 1 of 2\n\nBuild only this part of the contract:\n1\. Write one\.txt\n/,
  );
  assert.match(first, /It is done when:\n- one\.txt exists\n/);
  assert.match(first, /Not this round: step 2: Write two\.txt/);
  assert.match(
    first,
    /the lane holds for the owner's review: say what the owner should open or run/,
  );
  const started = board(r.root);

  build(out, "one.txt");
  const held = lane(r, "report", "T1", "--agent", "builder-1");
  assert.equal(held.exit, 0, held.stderr);
  out = held.json;
  assert.deepEqual([out.next, out.state], ["resume", "held"]);
  assert.match(
    out.held,
    new RegExp(
      `^for the owner, after step 1 of 2, since ${ISO} · evidence .*r1-build\\.report\\.md$`,
    ),
  );
  assert.match(out.run, /exec resume T1 --root '.*' --note "<the OK>"$/);
  assert.equal(out.why, "the owner reviews step 1 of 2 before the lane goes on");
  assert.equal(out.prompt, undefined);
  assert.equal(board(r.root), started, "a hold writes no board cell");
  const since = ledgerOf(r.root, "T1").hold.since;

  const shown = text(r, "show", "T1").split("\n");
  assert.equal(shown[0], "T1 · show → resume (held)");
  assert.match(shown[1], /^held: for the owner, after step 1 of 2/);
  assert.match(shown[2], /^run: .*exec resume T1 .*--note "<the OK>"$/);
  assert.ok(shown.includes("steps:") && shown.includes("  1. Write one.txt → owner OK"));

  const again = lane(r, "hold", "T1", "--for", "owner");
  assert.equal(again.exit, 0, again.stderr);
  assert.equal(ledgerOf(r.root, "T1").hold.since, since, "a second hold keeps since");
  assert.equal(board(r.root), started, "nor does a hold step");

  // A held lane is no writer: another lane starts at maxWriters 1, and then T1's resume is refused.
  const t4 = lane(r, "start", "T4");
  assert.equal(t4.exit, 0, t4.stderr);
  const capped = lane(r, "resume", "T1", "--note", "OK, go");
  assert.equal(capped.exit, 2);
  assert.match(capped.stderr, /1 writer\(s\) open, lanes\.maxWriters is 1/);
  assert.match(capped.stderr, /T4 \(building/);
  assert.equal(ledgerOf(r.root, "T1").state, "held");
  writeFileSync(t4.json.reportPath, "BLOCKED\nno way\n");
  assert.equal(lane(r, "report", "T4").exit, 1);
  const t4Done = board(r.root);

  const resumed = lane(r, "resume", "T1", "--note", "OK, go");
  assert.equal(resumed.exit, 0, resumed.stderr);
  out = resumed.json;
  assert.deepEqual([out.next, out.mode, out.agent], ["continue", "resume", "builder-1"]);
  assert.match(out.approved, new RegExp(`^step 1 of 2 at ${ISO}: "OK, go"$`));
  const brief = readFileSync(out.brief, "utf8");
  assert.match(brief, /^# Fix T1, round 2/);
  assert.match(
    brief,
    new RegExp(`## The owner's answer\\n\\n"OK, go" \\(${ISO}\\)\\n\\nGo on to the steps below\\.`),
  );
  assert.match(brief, /## This round: step 2 of 2/);
  assert.match(brief, /Built before this round \(on the branch\): step 1\./);
  assert.match(brief, /Not this round: none: the verifier then reads the whole contract/);
  assert.doesNotMatch(brief, /the lane holds for the owner's review/);
  const ledger = ledgerOf(r.root, "T1");
  assert.equal(ledger.holds[0].note, "OK, go");
  assert.match(ledger.holds[0].resumedAt, new RegExp(`^${ISO}$`));
  assert.equal(ledger.hold, undefined);
  assert.equal(board(r.root), t4Done, "a resume that carries on building writes no board cell");

  build(out, "two.txt");
  out = lane(r, "report", "T1", "--agent", "builder-1").json;
  assert.deepEqual([out.next, out.mode], ["verify", "fresh"]);
  const verify = readFileSync(out.brief, "utf8");
  assert.match(
    verify,
    new RegExp(
      `The owner reviewed and approved these; judge the rest against the contract, not the owner's call:\\n\\n- approved: step 1 of 2 at ${ISO}: "OK, go"`,
    ),
  );
  assert.match(board(r.root), /\| T1 {3}\| verify/);
  assert.deepEqual(
    ledgerOf(r.root, "T1").rounds.map((x) => x.step),
    ["build", "continue", "verify"],
  );
  writeFileSync(out.reportPath, "All checked.\nused_memories: none\nVerdict: PASS\n");
  assert.equal(lane(r, "verdict", "T1").json.next, "gate");
  assert.equal(lane(r, "gate", "T1").json.next, "close");
  assert.match(lane(r, "close", "T1").json.episode.outcome, /; owner holds: 1$/);
});

test("a main edit made while the lane is held refuses the resume, and the lane stays held until it is undone", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out, "one.txt");
  assert.equal(lane(r, "report", "T1").json.state, "held");
  writeFileSync(join(r.root, "stray.txt"), "oops\n");
  const refused = lane(r, "resume", "T1", "--note", "OK");
  assert.equal(refused.exit, 2);
  assert.match(
    refused.stderr,
    /main changed while T1 was held: files changed: \?\? stray\.txt: undo that, then resume/,
  );
  assert.equal(ledgerOf(r.root, "T1").state, "held");
  rmSync(join(r.root, "stray.txt"));
  const resumed = lane(r, "resume", "T1", "--note", "OK");
  assert.equal(resumed.exit, 0, resumed.stderr);
  assert.equal(resumed.json.next, "continue");
});

test("a lane without steps: hold waits for the saved reply, then holds mid-build; --redo is refused; resume continues it", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  assert.equal(out.steps, undefined);
  const early = lane(r, "hold", "T3", "--for", "owner");
  assert.equal(early.exit, 2);
  assert.match(
    early.stderr,
    /the builder is still out: save its reply to .*r1-build\.report\.md first, then hold/,
  );
  assert.match(lane(r, "hold", "T3", "--for", "boss").stderr, /--for takes owner or later/);
  writeFileSync(out.reportPath, "DONE_WITH_CONCERNS\nhalf there, have a look\n");
  assert.match(
    lane(r, "hold", "T3", "--for", "owner", "--evidence", "nope.png").stderr,
    /no file at nope\.png/,
  );
  const held = lane(r, "hold", "T3", "--for", "owner");
  assert.equal(held.exit, 0, held.stderr);
  assert.match(
    held.json.held,
    /^for the owner, mid-build, since .* · evidence .*r1-build\.report\.md$/,
  );
  assert.match(lane(r, "report", "T3").stderr, /the lane expects resume now, not a report/);
  const redo = lane(r, "resume", "T3", "--note", "again", "--redo");
  assert.equal(redo.exit, 2);
  assert.match(redo.stderr, /--redo goes back over a finished run; this hold is during one/);
  assert.match(lane(r, "resume", "T3").stderr, /resume needs --note "<the owner's words>"/);

  assert.match(lane(r, "close", "T3").stderr, /the lane is not done \(state held, next resume\)/);
  const owns = lane(r, "owns", "T3", "--set", "three.txt,more.txt", "--apply");
  assert.equal(owns.exit, 0, owns.stderr);
  assert.equal(owns.json.rewrote, undefined, "a held lane has no brief waiting");
  const merge = spawnLane(r, ["merge", "T3", "--message", "feat: land T3"]);
  assert.notEqual(merge.status, 0);
  assert.match(merge.stdout + merge.stderr, /T3's lane is "held": only a verified lane lands/);

  const resumed = lane(r, "resume", "T3", "--note", "looks right, carry on");
  assert.equal(resumed.exit, 0, resumed.stderr);
  assert.equal(resumed.json.next, "continue");
  assert.match(resumed.json.noted, /^mid-build at .*: "looks right, carry on"$/);
  assert.match(
    readFileSync(resumed.json.brief, "utf8"),
    /Carry on with the same steps, to that answer\./,
  );
  const ledger = ledgerOf(r.root, "T3");
  assert.deepEqual([ledger.rounds[0].held, ledger.rounds[0].report], [true, undefined]);
  assert.match(
    lane(r, "resume", "T3", "--note", "x").stderr,
    /the lane is not held \(state building, next continue\)/,
  );
});

test("start refuses a contract whose steps skip a number", () => {
  const r = repo();
  const res = lane(r, "start", "T2");
  assert.equal(res.exit, 2);
  assert.match(res.stderr, /contract T2: steps must be numbered 1 to N with no gap \(found 1, 3\)/);
});

test("a lane parked mid-round with uncommitted work is no writer", () => {
  const r = repo({ lanes: { maxWriters: 1 } });
  const out = lane(r, "start", "T1").json;
  writeFileSync(join(out.worktree, "one.txt"), "half\n");
  const parked = lane(r, "hold", "T1", "--for", "later", "--note", "laptop died");
  assert.equal(parked.exit, 0, parked.stderr);
  assert.match(parked.json.held, new RegExp(`^parked, since ${ISO}: "laptop died"$`));
  assert.equal(parked.json["main moved while parked"], undefined, "main is as the lane left it");
  const ledger = ledgerOf(r.root, "T1");
  assert.deepEqual([ledger.hold.for, ledger.rounds[0].held], ["later", true]);
  const t4 = lane(r, "start", "T4");
  assert.equal(t4.exit, 0, t4.stderr);
});

test("a lane tripped by a commit on main parks (exit 0) with the moved-main line, then resume refuses", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  writeFileSync(join(out.worktree, "three.txt"), "half\n");
  commitFile(r.root, "stray.txt", "x\n", "chore: by hand");
  const parked = lane(r, "hold", "T3", "--for", "later");
  assert.equal(parked.exit, 0, parked.stderr);
  assert.match(parked.json.held, new RegExp(`^parked, since ${ISO}$`));
  const moved = /^HEAD moved [0-9a-f]{7} → [0-9a-f]{7}; resume re-checks it$/;
  assert.match(parked.json["main moved while parked"], moved);
  const ledger = ledgerOf(r.root, "T3");
  assert.deepEqual(
    [ledger.state, ledger.hold.for, ledger.rounds[0].held, ledger.rounds[0].report],
    ["held", "later", true, undefined],
    "the round out is left unread",
  );
  assert.equal(readFileSync(join(out.worktree, "three.txt"), "utf8"), "half\n");

  const shown = text(r, "hold", "T3", "--for", "later").split("\n");
  assert.match(shown[1], new RegExp(`^held: parked, since ${ISO}$`));
  assert.ok(
    shown.some((l) => /^main moved while parked: HEAD moved .*; resume re-checks it$/.test(l)),
    shown.join("\n"),
  );
  const refused = lane(r, "resume", "T3", "--note", "go on");
  assert.equal(refused.exit, 2);
  assert.match(
    refused.stderr,
    /main changed while T3 was held: HEAD moved [0-9a-f]{7} → [0-9a-f]{7}: undo that, then resume/,
  );
  assert.equal(ledgerOf(r.root, "T3").state, "held");
});

test("hold --for owner on a tripped lane still refuses and names the report step", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  writeFileSync(out.reportPath, "DONE\nhave a look\n");
  writeFileSync(join(r.root, "stray.txt"), "x\n");
  const refused = lane(r, "hold", "T3", "--for", "owner");
  assert.equal(refused.exit, 2);
  assert.match(
    refused.stderr,
    /main touched: files changed: \?\? stray\.txt: run .*exec report T3 --root .* \(the report stops the lane\)/,
  );
  assert.equal(ledgerOf(r.root, "T3").state, "building");
});

test("a parked lane resumes its builder with the parked line, or a fresh builder with --fresh", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out, "one.txt");
  lane(r, "report", "T1", "--agent", "builder-1");
  out = lane(r, "resume", "T1", "--note", "OK").json;
  assert.equal(out.agent, "builder-1");

  writeFileSync(join(out.worktree, "two.txt"), "half\n");
  assert.equal(lane(r, "hold", "T1", "--for", "later").exit, 0);
  out = lane(r, "resume", "T1", "--note", "go on").json;
  assert.deepEqual([out.next, out.mode, out.agent], ["continue", "resume", "builder-1"]);
  const brief = readFileSync(out.brief, "utf8");
  assert.match(
    brief,
    /The lane was parked with uncommitted work in the worktree: read git status first and carry on from it\./,
  );
  assert.match(brief, /## This round: step 2 of 2/);

  assert.equal(lane(r, "hold", "T1", "--for", "later").exit, 0);
  out = lane(r, "resume", "T1", "--note", "a new agent", "--fresh").json;
  assert.deepEqual([out.next, out.mode, out.agent], ["continue", "fresh", undefined]);
  assert.match(readFileSync(out.brief, "utf8"), /The lane was parked with uncommitted work/);
});

test("a hold may name the builder out on the round, and the resume goes back to it", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  writeFileSync(out.reportPath, "DONE\nhave a look\n");
  assert.equal(lane(r, "hold", "T3", "--for", "owner", "--agent", "builder-9").exit, 0);
  const resumed = lane(r, "resume", "T3", "--note", "fine").json;
  assert.deepEqual(
    [resumed.next, resumed.mode, resumed.agent],
    ["continue", "resume", "builder-9"],
  );
});

test("an after-step hold for the owner cannot be parked: exit 2, the ledger byte-identical (R1d-6 N9)", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out, "one.txt");
  lane(r, "report", "T1", "--agent", "builder-1");
  const file = join(r.root, ".agentry", "run", "process", "ledger", "T1.json");
  const before = readFileSync(file, "utf8");
  const parked = lane(r, "hold", "T1", "--for", "later", "--note", "lunch");
  assert.equal(parked.exit, 2);
  assert.match(
    parked.stderr,
    /T1 waits for the owner after step 1: resume it with the owner's words \(exec resume T1 --note "…"\), or keep it held/,
  );
  assert.equal(readFileSync(file, "utf8"), before, "nothing written");
  // The owner's own words still resume it.
  const resumed = lane(r, "resume", "T1", "--note", "OK").json;
  assert.match(resumed.approved, /^step 1 of 2 at .*: "OK"$/);
});

test("lane sweep --apply keeps a held lane's worktree", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out, "one.txt");
  assert.equal(lane(r, "report", "T1").json.state, "held");
  const sweep = spawnLane(r, ["sweep", "--apply"]);
  assert.equal(sweep.status, 0, sweep.stdout + sweep.stderr);
  assert.ok(existsSync(out.worktree), "the held worktree is kept");
  assert.equal(ledgerOf(r.root, "T1").state, "held");
});
