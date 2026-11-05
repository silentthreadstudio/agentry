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

test("a two-step lane holds for the owner after step 1, starts a fresh builder on step 2, then one verifier reads it all", () => {
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
  assert.deepEqual([out.next, out.mode, out.agent], ["continue", "fresh", undefined]);
  assert.match(out.approved, new RegExp(`^step 1 of 2 at ${ISO}: "OK, go"$`));
  const brief = readFileSync(out.brief, "utf8");
  assert.match(brief, /^# Fix T1, round 2/);
  assert.match(
    brief,
    new RegExp(`## The owner's answer\\n\\n"OK, go" \\(${ISO}\\)\\n\\nGo on to the steps below\\.`),
  );
  assert.match(brief, /## This round: step 2 of 2/);
  assert.match(
    brief,
    /The step before it ended with the report .*r1-build\.report\.md: if you are new/,
  );
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

test("a lane tripped by a commit on main touching its file parks (exit 0) with the moved-main line, then resume refuses naming restart", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  writeFileSync(join(out.worktree, "three.txt"), "half\n");
  const sha = commitFile(r.root, "three.txt", "x\n", "chore: by hand").slice(0, 7);
  const parked = lane(r, "hold", "T3", "--for", "later");
  assert.equal(parked.exit, 0, parked.stderr);
  assert.match(parked.json.held, new RegExp(`^parked, since ${ISO}$`));
  const moved = new RegExp(
    `^HEAD moved [0-9a-f]{7} → ${sha} \\(${sha} touches three\\.txt, this lane's files\\); resume re-checks it$`,
  );
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
    new RegExp(
      `main changed while T3 was held: HEAD moved [0-9a-f]{7} → ${sha} \\(${sha} touches three\\.txt, this lane's files\\) → .*exec restart T3 --root .* --carry`,
    ),
  );
  assert.equal(ledgerOf(r.root, "T3").state, "held");
});

// ---- resume past a moved main: the guard's one overlap rule --------------------------------

test("resume passes a main moved by commits touching none of the lane's files, and says so", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  writeFileSync(join(out.worktree, "three.txt"), "half\n");
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  commitFile(r.root, "docs/WORKFLOW.md", "x\n", "docs: by hand");
  commitFile(r.root, "four.txt", "T4's\n", "feat: another lane's file");
  const base = ledgerOf(r.root, "T3").base;
  const resumed = lane(r, "resume", "T3", "--note", "go on");
  assert.equal(resumed.exit, 0, resumed.stderr);
  assert.equal(resumed.json.next, "continue");
  assert.equal(
    resumed.json.moved,
    `main moved by 2 commits, none touching this lane's files: resuming on base ${base.slice(0, 7)}`,
  );
  assert.equal(ledgerOf(r.root, "T3").base, base);
});

test("the moved line counts only the commits the overlap rule judged, not another lane's landed picks", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  writeFileSync(join(out.worktree, "three.txt"), "half\n");
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  let t4 = lane(r, "start", "T4").json;
  build(t4, "four.txt");
  t4 = lane(r, "report", "T4").json;
  writeFileSync(t4.reportPath, "Checked.\nused_memories: none\nVerdict: PASS\n");
  assert.equal(lane(r, "verdict", "T4").json.next, "gate");
  assert.equal(lane(r, "gate", "T4").exit, 0);
  assert.equal(lane(r, "close", "T4").exit, 0);
  const landed = spawnLane(r, ["merge", "T4", "--message", "chore(board): land T4"]);
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  commitFile(r.root, "docs/NOTES.md", "x\n", "docs: by hand");
  const resumed = lane(r, "resume", "T3", "--note", "go on");
  assert.equal(resumed.exit, 0, resumed.stderr);
  assert.match(resumed.json.moved, /^main moved by 1 commits, none touching this lane's files: /);
});

test("resume with no move on main prints no moved line", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  writeFileSync(join(out.worktree, "three.txt"), "half\n");
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  const resumed = lane(r, "resume", "T3", "--note", "go on");
  assert.equal(resumed.exit, 0, resumed.stderr);
  assert.equal(resumed.json.moved, undefined);
});

test("resume refuses a main commit touching a file the worktree changed but does not own, committed or not", () => {
  for (const committed of [true, false]) {
    const r = repo();
    const out = lane(r, "start", "T3").json;
    if (committed) commitFile(out.worktree, "extra.txt", "lane\n", "feat: extra");
    else writeFileSync(join(out.worktree, "extra.txt"), "lane\n");
    assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
    const sha = commitFile(r.root, "extra.txt", "main\n", "chore: extra on main").slice(0, 7);
    const refused = lane(r, "resume", "T3", "--note", "go on");
    assert.equal(refused.exit, 2, `committed ${committed}`);
    assert.match(
      refused.stderr,
      new RegExp(
        `\\(${sha} touches extra\\.txt, this lane's files\\) → .*exec restart T3 --root .* --carry`,
      ),
      `committed ${committed}`,
    );
    assert.equal(ledgerOf(r.root, "T3").state, "held");
  }
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
    /main touched: files changed: \?\? stray\.txt: run .*exec report T3 --root .* \(the report holds the lane for the guard\)/,
  );
  assert.equal(ledgerOf(r.root, "T3").state, "building");
});

test("a parked lane resumes its builder with the parked line, or a fresh builder with --fresh", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out, "one.txt");
  lane(r, "report", "T1", "--agent", "builder-1");
  out = lane(r, "resume", "T1", "--note", "OK").json;
  assert.deepEqual(
    [out.mode, out.agent],
    ["fresh", undefined],
    "a new step starts a fresh builder",
  );

  writeFileSync(join(out.worktree, "two.txt"), "half\n");
  assert.equal(lane(r, "hold", "T1", "--for", "later", "--agent", "builder-2").exit, 0);
  out = lane(r, "resume", "T1", "--note", "go on").json;
  assert.deepEqual([out.next, out.mode, out.agent], ["continue", "resume", "builder-2"]);
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

// --- a verified lane parked for later ------------------------------------------------------

// T3 built, verified PASS and gated green: next close.
function verifiedLane(r, id = "T3") {
  const out = lane(r, "start", id).json;
  build(out, "three.txt");
  const verify = lane(r, "report", id, "--agent", "builder-1").json;
  writeFileSync(verify.reportPath, "All checked.\nused_memories: none\nVerdict: PASS\n");
  assert.equal(lane(r, "verdict", id, "--agent", "verifier-1").json.next, "gate");
  const gated = lane(r, "gate", id).json;
  assert.deepEqual([gated.state, gated.next], ["verified", "close"]);
  return gated;
}
const kept = (ledger) => ({
  rounds: ledger.rounds,
  gates: ledger.gates,
  closedTip: ledger.closedTip,
  gateTip: ledger.gateTip,
});

test("a verified lane parks for later: held with when verified, nothing in the worktree, board or rounds changes", () => {
  const r = repo();
  const { worktree } = verifiedLane(r);
  const before = ledgerOf(r.root, "T3");
  const head = git(worktree, "rev-parse", "HEAD");
  const cells = board(r.root);
  const parked = lane(r, "hold", "T3", "--for", "later", "--note", "after the release");
  assert.equal(parked.exit, 0, parked.stderr);
  assert.deepEqual([parked.json.state, parked.json.next], ["held", "resume"]);
  assert.match(
    parked.json.held,
    new RegExp(`^parked, verified, since ${ISO}: "after the release"$`),
  );
  assert.equal(parked.json.prompt, undefined, "no builder is sent");
  const ledger = ledgerOf(r.root, "T3");
  assert.deepEqual(
    [ledger.state, ledger.hold.for, ledger.hold.when, ledger.hold.next, ledger.hold.why],
    ["held", "later", "verified", "close", "after the release"],
  );
  assert.deepEqual(kept(ledger), kept(before), "rounds, gates and tips are as they were");
  assert.equal(git(worktree, "rev-parse", "HEAD"), head);
  assert.equal(git(worktree, "status", "--porcelain"), "");
  assert.equal(board(r.root), cells, "a park writes no board cell");
});

test("exec show of a parked verified lane prints held: parked, verified, since <ISO>", () => {
  const r = repo();
  verifiedLane(r);
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  const shown = text(r, "show", "T3").split("\n");
  assert.equal(shown[0], "T3 · show → resume (held)");
  assert.match(shown[1], new RegExp(`^held: parked, verified, since ${ISO}$`));
  assert.match(shown[2], /^run: .*exec resume T3 .*--note "<the OK>"$/);
});

test("resume makes a parked verified lane verified again with the same next step, no builder, the note kept", () => {
  const r = repo();
  verifiedLane(r);
  const before = ledgerOf(r.root, "T3");
  const cells = board(r.root);
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  const resumed = lane(r, "resume", "T3", "--note", "go ahead");
  assert.equal(resumed.exit, 0, resumed.stderr);
  assert.deepEqual([resumed.json.state, resumed.json.next], ["verified", "close"]);
  assert.equal(resumed.json.prompt, undefined, "no builder dispatch");
  assert.match(resumed.json.noted, new RegExp(`^verified at ${ISO}: "go ahead"$`));
  assert.match(resumed.json.run, /exec close T3 /);
  const ledger = ledgerOf(r.root, "T3");
  assert.equal(ledger.hold, undefined);
  assert.deepEqual([ledger.holds.at(-1).when, ledger.holds.at(-1).note], ["verified", "go ahead"]);
  assert.deepEqual(kept(ledger), kept(before), "its gate records and verdicts are kept");
  assert.equal(board(r.root), cells, "the resume writes no board cell");
  assert.match(text(r, "show", "T3"), /^holds: noted: verified at .*: "go ahead"$/m);
  assert.equal(lane(r, "close", "T3").json.next, "merge", "the lane closes as it would have");
});

test("a verified lane past close (next merge) parks and resumes to merge; merge refuses it while held", () => {
  const r = repo();
  verifiedLane(r);
  assert.equal(lane(r, "close", "T3").json.next, "merge");
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  assert.equal(ledgerOf(r.root, "T3").hold.next, "merge");
  const merge = spawnLane(r, ["merge", "T3", "--message", "feat: land T3"]);
  assert.equal(merge.status, 2);
  assert.match(merge.stdout + merge.stderr, /T3's lane is "held": only a verified lane lands/);
  const resumed = lane(r, "resume", "T3", "--note", "land it");
  assert.deepEqual([resumed.json.state, resumed.json.next], ["verified", "merge"]);
});

test("hold --for owner on a verified lane is refused, before and after it is parked", () => {
  const r = repo();
  verifiedLane(r);
  const ledger = readFileSync(
    join(r.root, ".agentry", "run", "process", "ledger", "T3.json"),
    "utf8",
  );
  const owner = lane(r, "hold", "T3", "--for", "owner");
  assert.equal(owner.exit, 2);
  assert.match(owner.stderr, /hold --for owner is for a builder's round/);
  assert.equal(
    readFileSync(join(r.root, ".agentry", "run", "process", "ledger", "T3.json"), "utf8"),
    ledger,
    "nothing written",
  );
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  const again = lane(r, "hold", "T3", "--for", "owner");
  assert.equal(again.exit, 2);
  assert.match(again.stderr, /hold --for owner is for a builder's round/);
});

test("resume --redo on a parked verified lane is refused, saying it is verified, not mid-run (R1d-22 N5)", () => {
  const r = repo();
  verifiedLane(r);
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  const redo = lane(r, "resume", "T3", "--note", "again", "--redo");
  assert.equal(redo.exit, 2);
  assert.match(
    redo.stderr,
    /--redo goes back over a finished run; this lane was parked verified, and resume makes it verified again/,
  );
  assert.doesNotMatch(redo.stderr, /during one/);
  assert.equal(ledgerOf(r.root, "T3").state, "held");
});

// ---- the needs-context budget per step and the context hold ---------------------------------

// The builder asks for a fact: no commit, the report saved.
const ask = (out, line = "which file holds the key?") =>
  writeFileSync(out.reportPath, `NEEDS_CONTEXT\n${line}\nused_memories: none\n`);

test("a two-step lane asking once in each step reaches verified, each ask re-dispatched with its todo", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  ask(out);
  out = lane(r, "report", "T1", "--agent", "builder-1").json;
  assert.deepEqual([out.next, out.mode, out.agent], ["needs-context", "resume", "builder-1"]);
  assert.match(out.todo, /^append the fact under "## The fact" at the end of /);
  build(out, "one.txt");
  out = lane(r, "report", "T1").json;
  assert.equal(out.state, "held");
  out = lane(r, "resume", "T1", "--note", "OK, go").json;
  assert.equal(out.next, "continue");
  ask(out, "and where does two.txt go?");
  out = lane(r, "report", "T1").json;
  assert.equal(out.next, "needs-context", "step 2 has a budget of its own");
  assert.equal(ledgerOf(r.root, "T1").hold, undefined);
  build(out, "two.txt");
  out = lane(r, "report", "T1").json;
  assert.equal(out.next, "verify");
  writeFileSync(out.reportPath, "All checked.\nused_memories: none\nVerdict: PASS\n");
  assert.equal(lane(r, "verdict", "T1").json.next, "gate");
  const gated = lane(r, "gate", "T1").json;
  assert.deepEqual([gated.state, gated.next], ["verified", "close"]);
  assert.deepEqual(
    ledgerOf(r.root, "T1").rounds.map((x) => x.step),
    ["build", "needs-context", "continue", "needs-context", "verify"],
  );
});

test("ART-10b: step 1 DONE, owner OK, a needs-context round: the lane offers step 2, never close", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out, "one.txt");
  assert.equal(lane(r, "report", "T1", "--agent", "builder-1").json.state, "held");
  out = lane(r, "resume", "T1", "--note", "OK, go").json;
  assert.deepEqual([out.next, out.mode], ["continue", "fresh"]);
  ask(out);
  out = lane(r, "report", "T1", "--agent", "builder-2").json;
  assert.deepEqual([out.next, out.mode, out.agent], ["needs-context", "resume", "builder-2"]);
  assert.equal(lane(r, "hold", "T1", "--for", "later").exit, 0);
  const held = ledgerOf(r.root, "T1");
  assert.deepEqual([held.state, held.next, held.hold.stepRun], ["held", "resume", [2, 2]]);
  assert.match(text(r, "show", "T1"), /^held: parked, since /m);
  out = lane(r, "resume", "T1", "--note", "go on").json;
  assert.notEqual(out.next, "close");
  assert.notEqual(out.next, "verify");
  assert.deepEqual(ledgerOf(r.root, "T1").rounds.at(-1).stepRun, [2, 2]);
});

test("resume --same keeps the step-1 builder for step 2 (no pointer line); --same with --fresh is refused", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out, "one.txt");
  lane(r, "report", "T1", "--agent", "builder-1");
  const both = lane(r, "resume", "T1", "--note", "OK", "--same", "--fresh");
  assert.equal(both.exit, 2);
  assert.match(both.stderr, /resume takes --same or --fresh, not both/);
  assert.equal(ledgerOf(r.root, "T1").state, "held");
  out = lane(r, "resume", "T1", "--note", "OK", "--same").json;
  assert.deepEqual([out.next, out.mode, out.agent], ["continue", "resume", "builder-1"]);
  const brief = readFileSync(out.brief, "utf8");
  assert.match(brief, /## This round: step 2 of 2/);
  assert.doesNotMatch(brief, /The step before it ended with the report/);
});

test("field 103: step 2 asks, owns --add, the context resume reports DONE: the brief names step 2 and the lane goes to the verifier, not close", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out, "one.txt");
  lane(r, "report", "T1", "--agent", "builder-1");
  out = lane(r, "resume", "T1", "--note", "OK, go").json;
  ask(out);
  out = lane(r, "report", "T1", "--agent", "builder-2").json;
  assert.equal(out.next, "needs-context");
  assert.equal(lane(r, "owns", "T1", "--add", "cfg/keys.json", "--apply").exit, 0);
  const brief = readFileSync(out.brief, "utf8");
  assert.match(brief, /## This round: step 2 of 2/);
  assert.match(brief, /You are on step 2 of 2: Write two\.txt/);
  assert.match(brief, /step is done only when its own work is/);
  // The resumed builder reports DONE; the round is step 2's, so the work goes to the verifier.
  build(out, "two.txt");
  out = lane(r, "report", "T1", "--agent", "builder-2").json;
  assert.deepEqual([out.next, out.state], ["verify", "verifying"]);
  assert.equal(ledgerOf(r.root, "T1").hold, undefined);
});

test("asked again in one step: held for the context, nothing changed; resume sends the fact to the builder", () => {
  const r = repo();
  let out = lane(r, "start", "T3").json;
  ask(out);
  out = lane(r, "report", "T3", "--agent", "builder-1").json;
  writeFileSync(join(out.worktree, "half.txt"), "half\n");
  ask(out, "still no key: see `cfg/keys.json` and `three.txt` first");
  const status = git(out.worktree, "status", "--porcelain");
  const cells = board(r.root);
  const held = lane(r, "report", "T3");
  assert.equal(held.exit, 0, held.stderr);
  assert.deepEqual(
    [held.json.state, held.json.next, held.json.prompt],
    ["held", "resume", undefined],
  );
  assert.match(
    held.json.held,
    /^the builder needs more context again → supply it: .*exec resume T3 --root '.*' --note "<the fact>"; or let it touch them: .*exec owns T3 --root '.*' --add cfg\/keys\.json --apply, then resume; or start it again with its work: .*exec restart T3 --root '.*' --carry$/,
  );
  assert.match(
    held.json.asks,
    /^still no key: see `cfg\/keys\.json` and `three\.txt` first \(.*r2-needs-context\.report\.md\), since /,
  );
  assert.match(held.json.run, /exec resume T3 .*--note "<the fact>"$/);
  const ledger = ledgerOf(r.root, "T3");
  assert.deepEqual(
    [ledger.hold.for, ledger.hold.report, ledger.rounds.at(-1).status],
    ["context", ledger.rounds[1].reportPath, "NEEDS_CONTEXT"],
  );
  assert.equal(git(out.worktree, "status", "--porcelain"), status, "the worktree is as it was");
  assert.equal(board(r.root), cells);
  // The text view says it too; show prints the same lines.
  assert.match(text(r, "show", "T3"), /^held: the builder needs more context again → supply it: /m);

  const resumed = lane(r, "resume", "T3", "--note", "the key is `id` in three.txt");
  assert.equal(resumed.exit, 0, resumed.stderr);
  out = resumed.json;
  assert.deepEqual([out.next, out.mode, out.agent], ["needs-context", "resume", "builder-1"]);
  assert.equal(out.todo, undefined, "the fact is in the brief already");
  const brief = readFileSync(out.brief, "utf8");
  assert.match(
    brief,
    /## Supplied context\n\nYou asked for a fact in .*r2-needs-context\.report\.md/,
  );
  assert.ok(brief.endsWith("\n## The fact\n\nthe key is `id` in three.txt\n"), brief);
  assert.equal(ledgerOf(r.root, "T3").holds.at(-1).for, "context");
});

test("a guard trip on the report that asks again is a guard hold; once main is clean it holds for the context", () => {
  const r = repo();
  let out = lane(r, "start", "T3").json;
  ask(out);
  out = lane(r, "report", "T3").json;
  ask(out);
  writeFileSync(join(r.root, "stray.txt"), "oops\n");
  const tripped = lane(r, "report", "T3");
  assert.equal(tripped.exit, 0, tripped.stderr);
  assert.equal(ledgerOf(r.root, "T3").hold.for, "guard");
  rmSync(join(r.root, "stray.txt"));
  const again = lane(r, "report", "T3");
  assert.equal(again.exit, 0, again.stderr);
  assert.equal(ledgerOf(r.root, "T3").hold.for, "context");
  assert.match(again.json.held, /^the builder needs more context again/);
  // No path outside owns named: no owns hint; a restart is still the other way on.
  assert.doesNotMatch(again.json.held, /let it touch them/);
  assert.match(again.json.held, /; or start it again with its work: .*exec restart T3 .*--carry$/);
});

test("exec gate on a held lane refuses, records nothing and runs nothing: a context hold and a step hold", () => {
  // The gate ran and was recorded while the lane stayed held.
  const r = repo();
  let out = lane(r, "start", "T3").json;
  ask(out);
  out = lane(r, "report", "T3").json;
  ask(out);
  assert.equal(lane(r, "report", "T3").json.state, "held");
  build(lane(r, "start", "T1").json, "one.txt");
  assert.equal(lane(r, "report", "T1").json.state, "held");
  for (const [id, why] of [
    ["T3", "context"],
    ["T1", "owner"],
  ]) {
    const before = readFileSync(
      join(r.root, ".agentry", "run", "process", "ledger", `${id}.json`),
      "utf8",
    );
    const refused = lane(r, "gate", id);
    assert.equal(refused.exit, 2, refused.stderr);
    assert.match(refused.stderr, new RegExp(`${id} is held \\(${why}\\): resume it first`));
    assert.equal(
      readFileSync(join(r.root, ".agentry", "run", "process", "ledger", `${id}.json`), "utf8"),
      before,
    );
    const logs = join(r.root, ".agentry", "run", "process", "runs", id, "logs");
    assert.equal(existsSync(join(logs, "gate-1.log")), false, "no gate ran");
  }
});

test("exec gate on a lane the guard holds refuses, naming the report, and runs nothing", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  build(out, "three.txt");
  writeFileSync(join(r.root, "stray.txt"), "oops\n");
  assert.equal(lane(r, "report", "T3").json.hold.for, "guard");
  const file = join(r.root, ".agentry", "run", "process", "ledger", "T3.json");
  const before = readFileSync(file, "utf8");
  const refused = lane(r, "gate", "T3");
  assert.equal(refused.exit, 2, refused.stderr);
  assert.match(refused.stderr, /T3 is held by a guard trip: run its report once main is fixed$/m);
  assert.equal(readFileSync(file, "utf8"), before);
  const logs = join(r.root, ".agentry", "run", "process", "runs", "T3", "logs");
  assert.equal(existsSync(join(logs, "gate-1.log")), false, "no gate ran");
});

test("heldText names a context hold's reason and the resume that answers it", () => {
  const hold = { for: "context", when: "during", reason: "which key?", report: "/r", since: "t" };
  assert.equal(heldText(hold, 0), 'for more context: which key? · resume with --note "<the fact>"');
});

test("owns --add on a lane held for the context: appended, a path already owned changes nothing and says so", () => {
  const r = repo();
  let out = lane(r, "start", "T3").json;
  ask(out);
  out = lane(r, "report", "T3").json;
  ask(out, "needs: cfg/keys.json");
  assert.match(lane(r, "report", "T3").json.held, /--add cfg\/keys\.json --apply, then resume; /);
  const preview = lane(r, "owns", "T3", "--add", "cfg/keys.json");
  assert.deepEqual([preview.exit, preview.json.applied], [0, false]);
  assert.equal(ledgerOf(r.root, "T3").owned.length, 1, "a preview writes nothing");
  const added = lane(r, "owns", "T3", "--add", "cfg/keys.json,three.txt", "--apply");
  assert.equal(added.exit, 0, added.stderr);
  assert.deepEqual(
    added.json.owned.map((o) => o.path),
    ["three.txt", "cfg/keys.json"],
  );
  assert.equal(added.json["already owned"], "three.txt");
  assert.equal(added.json.rewrote, undefined, "a held lane has no brief waiting");
  const bytes = readFileSync(
    join(r.root, ".agentry", "run", "process", "ledger", "T3.json"),
    "utf8",
  );
  const same = lane(r, "owns", "T3", "--add", "cfg/keys.json", "--apply");
  assert.deepEqual([same.exit, same.json.applied], [0, false]);
  assert.equal(same.json.unchanged, "already owned: cfg/keys.json");
  assert.equal(
    readFileSync(join(r.root, ".agentry", "run", "process", "ledger", "T3.json"), "utf8"),
    bytes,
    "nothing is written",
  );
  const resumed = lane(r, "resume", "T3", "--note", "touch it").json;
  assert.match(readFileSync(resumed.brief, "utf8"), /- `cfg\/keys\.json` \(new\)/);
});

test("hold on a lane held for more context is refused, the hold kept, so the resume still sends the fact", () => {
  // Hold --for later re-parked it, and the resume then sent continue.
  const r = repo();
  let out = lane(r, "start", "T3").json;
  ask(out);
  out = lane(r, "report", "T3", "--agent", "b1").json;
  ask(out);
  assert.equal(lane(r, "report", "T3").json.state, "held");
  const ledger = join(r.root, ".agentry", "run", "process", "ledger", "T3.json");
  const before = readFileSync(ledger, "utf8");
  for (const holdFor of ["later", "owner"]) {
    const refused = lane(r, "hold", "T3", "--for", holdFor);
    assert.equal(refused.exit, 2);
    assert.match(refused.stderr, /T3 is held for more context: resume it with --note "<the fact>"/);
  }
  assert.equal(readFileSync(ledger, "utf8"), before);
  assert.equal(lane(r, "resume", "T3", "--note", "the fact").json.next, "needs-context");
});

test("owns refuses a path that leaves the repository; the hint names only paths, never one outside", () => {
  // --add ../outside.txt and /etc/passwd were taken, and the hint offered
  // exec.noteRounds, e.g and ../up.txt.
  const r = repo();
  let out = lane(r, "start", "T3").json;
  ask(out);
  out = lane(r, "report", "T3").json;
  const filler = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n");
  writeFileSync(
    out.reportPath,
    `NEEDS_CONTEXT\nsee \`exec.noteRounds\`, \`e.g.\`, \`npm test\`, \`node:sqlite\`, \`three.txt\`, \`../up.txt\`\nneeds: src/x.mjs, src/y.mjs\n${filler}\n\`late/path.txt\`\nused_memories: none\n`,
  );
  const held = lane(r, "report", "T3").json;
  assert.match(held.held, / --add src\/x\.mjs,src\/y\.mjs --apply, then resume; /);
  const before = ledgerOf(r.root, "T3").owned;
  for (const [flag, path] of [
    ["--add", "../outside.txt"],
    ["--add", "/etc/passwd"],
    ["--add", "src/../../x"],
    ["--set", "three.txt,../up.txt"],
  ]) {
    const refused = lane(r, "owns", "T3", flag, path, "--apply");
    assert.equal(refused.exit, 2, path);
    assert.match(refused.stderr, /leaves the repository/, path);
  }
  assert.deepEqual(ledgerOf(r.root, "T3").owned, before);
});

test("owns and its hint judge a path normalised: .//etc/passwd leaves the repository", () => {
  // The ./ strip ran after the check, so .//etc/passwd was stored as
  // /etc/passwd, and the hint offered .//abs.txt.
  const r = repo();
  let out = lane(r, "start", "T3").json;
  ask(out);
  out = lane(r, "report", "T3").json;
  ask(
    out,
    "needs: .//abs.txt, /etc/hosts, ../x.txt, a/../../b.txt, ok/new.txt, ./ok//two.txt\nalso `/etc/passwd` and `.//t.txt`",
  );
  const held = lane(r, "report", "T3").json;
  assert.match(held.held, / --add ok\/new\.txt,ok\/two\.txt --apply, then resume; /);
  const before = ledgerOf(r.root, "T3").owned;
  for (const [flag, path] of [
    ["--add", ".//etc/passwd"],
    ["--add", "././/etc/passwd"],
    ["--set", "three.txt,.//etc/passwd"],
  ]) {
    const refused = lane(r, "owns", "T3", flag, path, "--apply");
    assert.equal(refused.exit, 2, path);
    assert.match(refused.stderr, /leaves the repository/, path);
  }
  assert.deepEqual(ledgerOf(r.root, "T3").owned, before);
  const added = lane(r, "owns", "T3", "--add", "./ok//new.txt", "--apply");
  assert.equal(added.exit, 0, added.stderr);
  assert.deepEqual(
    added.json.owned.map((o) => o.path),
    ["three.txt", "ok/new.txt"],
  );
});

test("the owns hint drops a word starting with -, so the command it prints runs", () => {
  // `--apply/y` gave `--add --apply/y,real/path.mjs --apply`.
  const r = repo();
  let out = lane(r, "start", "T3").json;
  ask(out);
  out = lane(r, "report", "T3").json;
  ask(out, "see `--apply/y` and `-x/y.txt`\nneeds: -rf/z.txt, real/path.mjs");
  const held = lane(r, "report", "T3").json;
  assert.match(held.held, / --add real\/path\.mjs --apply, then resume; /);
  assert.doesNotMatch(held.held, /--add -/);
});

test("owns --add counts a path an owned entry already covers as owned: a directory, ./ and a trailing /", () => {
  // With lib/ owned, lib/a.txt and ./lib/ were appended; ./three.txt beside three.txt too.
  const r = repo();
  let out = lane(r, "start", "T3").json;
  ask(out);
  out = lane(r, "report", "T3").json;
  assert.equal(lane(r, "owns", "T3", "--add", "lib/", "--apply").exit, 0);
  const covered = lane(r, "owns", "T3", "--add", "lib/a.txt,./lib/,./three.txt", "--apply");
  assert.equal(covered.exit, 0, covered.stderr);
  assert.deepEqual(
    [covered.json.applied, covered.json.unchanged],
    [false, "already owned: lib/a.txt, ./lib/, ./three.txt"],
  );
  assert.deepEqual(
    ledgerOf(r.root, "T3").owned.map((o) => o.path),
    ["three.txt", "lib"],
  );
  // A new path given as ./x/ is stored as x.
  const added = lane(r, "owns", "T3", "--add", "./cfg/", "--apply");
  assert.deepEqual(
    added.json.owned.map((o) => o.path),
    ["three.txt", "lib", "cfg"],
  );
});

test("owns --add in needs-context rewrites the waiting brief, keeping the fact; a verified or merged lane refuses it", () => {
  const r = repo();
  let out = lane(r, "start", "T3").json;
  ask(out, "needs: four.txt");
  out = lane(r, "report", "T3").json;
  assert.match(
    out.todo,
    /; or let it touch them: .*exec owns T3 .*--add four\.txt --apply, then resume$/,
  );
  writeFileSync(
    out.brief,
    `${readFileSync(out.brief, "utf8")}\n## The fact\n\nfour.txt is yours\n`,
  );
  const added = lane(r, "owns", "T3", "--add", "four.txt", "--apply");
  assert.equal(added.exit, 0, added.stderr);
  assert.equal(added.json.rewrote, out.brief);
  const brief = readFileSync(out.brief, "utf8");
  assert.match(brief, /- `four\.txt` \(new\)/);
  assert.ok(brief.trimEnd().endsWith("## The fact\n\nfour.txt is yours"), brief);

  const v = repo();
  verifiedLane(v);
  const before = readFileSync(
    join(v.root, ".agentry", "run", "process", "ledger", "T3.json"),
    "utf8",
  );
  const refused = lane(v, "owns", "T3", "--add", "x.txt", "--apply");
  assert.equal(refused.exit, 2);
  assert.match(
    refused.stderr,
    /owns --add is for a lane still building: T3 is verified \(next close\)/,
  );
  const merged = ledgerOf(v.root, "T3");
  writeFileSync(
    join(v.root, ".agentry", "run", "process", "ledger", "T3.json"),
    JSON.stringify({ ...merged, state: "merged", next: null }),
  );
  assert.match(lane(v, "owns", "T3", "--add", "x.txt").stderr, /T3 is merged/);
  assert.ok(before.length > 0);
  assert.match(
    lane(v, "owns", "T3", "--add", "a", "--set", "b").stderr,
    /owns takes --set or --add, not both/,
  );
});

// ---- the notes cap on a flagged item ----------------------------------------------------------

// A repo whose T3 is flagged, under `exec`.
function flaggedRepo(exec = { noteRounds: 0, final: "never" }) {
  const r = repo();
  const spec = structuredClone(SPEC);
  spec.kinds.task.fields.flag = { column: "Flag", type: "flag", mark: "x" };
  spec.exec = exec;
  const rows = BOARD_MD.replace("| Task | Status | Verdict |", "| Task | Status | Verdict | Flag |")
    .replace("| ---- | ------ | ------- |", "| ---- | ------ | ------- | ---- |")
    .replace(
      /^(\| T\d +\| todo +\| +\|)$/gm,
      (row) => `${row}${row.startsWith("| T3") ? " x    |" : "      |"}`,
    );
  commitFile(r.root, "plan/BOARD.md", rows);
  writeSpec(join(r.root, ".agentry"), spec);
  git(r.root, "add", ".agentry");
  git(r.root, "commit", "-q", "-m", "flag T3");
  return r;
}
// T3 built and judged PASS WITH NOTES with one note: the verdict step's result.
function noted(r) {
  const out = lane(r, "start", "T3").json;
  build(out, "three.txt");
  const verify = lane(r, "report", "T3", "--agent", "builder-1").json;
  writeFileSync(
    verify.reportPath,
    "N1 rename the helper\nused_memories: none\nVerdict: PASS WITH NOTES\n",
  );
  return lane(r, "verdict", "T3", "--agent", "verifier-1");
}

test("a flagged item at the notes cap with a note open holds for the owner; resume closes it as is", () => {
  const r = flaggedRepo();
  const v = noted(r);
  assert.equal(v.exit, 0, v.stderr);
  assert.deepEqual([v.json.state, v.json.next], ["held", "resume"]);
  assert.match(
    v.json.held,
    /^for the owner: notes cap reached with open notes on a flagged item, since .* · evidence .*r2-verify\.report\.md → close it as is: .*exec resume T3 .*--note "<the OK>", or send it back on your word: .*exec fix T3 .*--owner "<the change>"$/,
  );
  assert.equal(v.json.why, "notes cap reached with open notes on a flagged item");
  assert.deepEqual(ledgerOf(r.root, "T3").openNotes, ["N1 rename the helper"]);
  assert.match(board(r.root), /\| T3 +\| verify +\| PASS WITH NOTES/);
  // Not past it by the cap alone: no notes round, no park, no close.
  assert.match(
    lane(r, "fix", "T3", "--notes", "N1").stderr,
    /0 of 0 notes rounds are used \(exec\.noteRounds is 0\) and this flagged item holds for you at the cap: resume to close as is \(.*exec resume T3 .*\), or fix --owner \(.*exec fix T3 .*--owner "<the change>"\)/,
  );
  assert.match(
    lane(r, "hold", "T3", "--for", "later").stderr,
    /T3 waits for the owner at its notes cap/,
  );
  assert.match(lane(r, "close", "T3").stderr, /the lane is not done/);
  const ok = lane(r, "resume", "T3", "--note", "ship it with N1 open");
  assert.equal(ok.exit, 0, ok.stderr);
  assert.equal(ok.json.next, "gate");
  assert.match(ok.json.noted, /^at the notes cap at .*: "ship it with N1 open"$/);
  assert.equal(lane(r, "gate", "T3").json.next, "close");
});

test("held at the notes cap: a cap raised since lets fix --notes send one more notes round", () => {
  // The raised cap was not read while the item held.
  const r = flaggedRepo();
  assert.equal(noted(r).json.state, "held");
  const spec = structuredClone(SPEC);
  spec.kinds.task.fields.flag = { column: "Flag", type: "flag", mark: "x" };
  spec.exec = { noteRounds: 1, final: "never" };
  writeSpec(join(r.root, ".agentry"), spec); // uncommitted: no guard or gate key changes
  const sent = lane(r, "fix", "T3", "--notes", "N1");
  assert.equal(sent.exit, 0, sent.stderr);
  assert.deepEqual(
    [sent.json.next, sent.json.mode, sent.json.agent],
    ["fix", "resume", "builder-1"],
  );
  const ledger = ledgerOf(r.root, "T3");
  assert.equal(ledger.hold, undefined);
  assert.match(ledger.holds.at(-1).note, /^a notes round on N1: exec\.noteRounds is 1 now$/);
  build(sent.json, "renamed.txt");
  assert.equal(lane(r, "report", "T3").json.next, "recheck");
});

test("a second fix --notes while the notes round is out says to wait for its report, at the cap or under it", () => {
  // At the cap it said the gate goes on with the notes open, a builder still out.
  for (const noteRounds of [1, 2]) {
    const r = flaggedRepo({ noteRounds, final: "never" });
    assert.equal(noted(r).json.next, "gate");
    assert.equal(lane(r, "fix", "T3", "--notes", "N1").json.next, "fix");
    const before = ledgerOf(r.root, "T3");
    const again = lane(r, "fix", "T3", "--notes", "N1");
    assert.equal(again.exit, 2, again.stderr);
    assert.match(again.stderr, /✗ lane exec fix T3: a notes round is out: wait for its report$/m);
    assert.deepEqual(ledgerOf(r.root, "T3"), before, `noteRounds ${noteRounds}`);
  }
});

test("held at the notes cap: owns --add is refused as on a verified lane", () => {
  // It was applied on a lane past its passing verdict.
  const r = flaggedRepo();
  assert.equal(noted(r).json.state, "held");
  const before = ledgerOf(r.root, "T3").owned;
  const refused = lane(r, "owns", "T3", "--add", "x.txt", "--apply");
  assert.equal(refused.exit, 2);
  assert.match(
    refused.stderr,
    /owns --add is for a lane still building: T3 is held at its notes cap \(next resume\); a change now is the owner's/,
  );
  assert.deepEqual(ledgerOf(r.root, "T3").owned, before);
});

test("owns --add is refused between a passing verdict and the gate, and after a resumed cap hold", () => {
  // The refusal tested state "verified" only, so next gate let it through.
  const r = repo();
  let out = lane(r, "start", "T3").json;
  build(out, "three.txt");
  out = lane(r, "report", "T3").json;
  writeFileSync(out.reportPath, "All checked.\nused_memories: none\nVerdict: PASS\n");
  assert.deepEqual(
    [lane(r, "verdict", "T3").json.state, ledgerOf(r.root, "T3").next],
    ["verifying", "gate"],
  );
  const before = ledgerOf(r.root, "T3").owned;
  for (const args of [["--apply"], []]) {
    const refused = lane(r, "owns", "T3", "--add", "x.txt", ...args);
    assert.equal(refused.exit, 2, refused.stderr);
    assert.match(
      refused.stderr,
      /owns --add is for a lane still building: T3 is past a passing verdict \(PASS\) \(next gate\); a change now is the owner's/,
    );
  }
  assert.deepEqual(ledgerOf(r.root, "T3").owned, before);

  const c = flaggedRepo();
  assert.equal(noted(c).json.state, "held");
  assert.equal(lane(c, "resume", "T3", "--note", "ship it").json.next, "gate");
  const capped = lane(c, "owns", "T3", "--add", "x.txt", "--apply");
  assert.equal(capped.exit, 2);
  assert.match(capped.stderr, /T3 is past a passing verdict \(PASS WITH NOTES\) \(next gate\)/);
});

test("owns --add is taken again once a builder round follows the passing verdict", () => {
  const r = flaggedRepo({ noteRounds: 1, final: "never" });
  assert.equal(noted(r).json.next, "gate");
  assert.equal(lane(r, "fix", "T3", "--notes", "N1").json.next, "fix");
  const added = lane(r, "owns", "T3", "--add", "x.txt", "--apply");
  assert.equal(added.exit, 0, added.stderr);
  assert.equal(added.json.applied, true);
});

test("held at the notes cap: fix --owner sends it back to its builder, then the recheck", () => {
  const r = flaggedRepo();
  assert.equal(noted(r).json.state, "held");
  const sent = lane(r, "fix", "T3", "--owner", "rename it now");
  assert.equal(sent.exit, 0, sent.stderr);
  assert.deepEqual(
    [sent.json.next, sent.json.mode, sent.json.agent],
    ["fix", "resume", "builder-1"],
  );
  assert.equal(ledgerOf(r.root, "T3").hold, undefined);
  build(sent.json, "renamed.txt");
  assert.equal(lane(r, "report", "T3").json.next, "recheck");
});

test("an item not flagged at the cap goes on to the gate; fix --notes names the owner's way past the cap", () => {
  const r = repo();
  const spec = { ...SPEC, exec: { noteRounds: 0, final: "never" } };
  writeSpec(join(r.root, ".agentry"), spec);
  git(r.root, "add", ".agentry");
  git(r.root, "commit", "-q", "-m", "no notes rounds");
  const v = noted(r).json;
  assert.equal(v.next, "gate");
  const fix = lane(r, "fix", "T3", "--notes", "N1");
  assert.equal(fix.exit, 2);
  assert.match(
    fix.stderr,
    /0 of 0 notes rounds are used \(exec\.noteRounds is 0; next is gate: .*exec gate T3 .* goes on with the notes open\) → raise exec\.noteRounds, or send it back on your word: .*exec fix T3 --root '.*' --owner "<the change>"/,
  );
});

// ---- an external block holds the lane; fix --owner on a held lane says what to do (fields 98, 104) -----

const blockedBy = (out, line = "BLOCKED: external: the API key is not issued yet") =>
  writeFileSync(out.reportPath, `${line}\nnothing to build until then\nused_memories: none\n`);

test("BLOCKED: external holds the lane with the reason, the board and worktree untouched; a plain BLOCKED still stops", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  const cells = board(r.root);
  blockedBy(out);
  const held = lane(r, "report", "T3", "--agent", "builder-1");
  assert.equal(held.exit, 0, held.stderr);
  assert.deepEqual([held.json.state, held.json.next], ["held", "resume"]);
  assert.match(
    held.json.held,
    /^blocked: the API key is not issued yet → clear it, then .*exec resume T3 --root '.*' --note "<what changed>"/,
  );
  assert.match(text(r, "show", "T3"), /^held: blocked: the API key is not issued yet → /m);
  const ledger = ledgerOf(r.root, "T3");
  assert.deepEqual(
    [ledger.hold.for, ledger.hold.reason, ledger.rounds.length, ledger.stopReason],
    ["blocked", "the API key is not issued yet", 1, undefined],
  );
  assert.equal(board(r.root), cells);

  const code = lane(r, "start", "T4").json;
  writeFileSync(code.reportPath, "BLOCKED\nthe parser cannot read it\nused_memories: none\n");
  assert.equal(lane(r, "report", "T4").exit, 1);
  assert.equal(ledgerOf(r.root, "T4").state, "stopped");
});

test("resume on a blocked hold sends the same round again to a fresh builder with the note; --same keeps the builder", () => {
  const r = repo();
  let out = lane(r, "start", "T3").json;
  blockedBy(out, "**BLOCKED: external: the API key is not issued yet**");
  lane(r, "report", "T3", "--agent", "builder-1");
  const resumed = lane(r, "resume", "T3", "--note", "the key is issued");
  assert.equal(resumed.exit, 0, resumed.stderr);
  out = resumed.json;
  assert.deepEqual([out.next, out.mode, out.agent], ["build", "fresh", undefined]);
  assert.match(
    readFileSync(out.brief, "utf8"),
    /\n## The fact\n\nThe last builder stopped on: the API key is not issued yet \(its report .*r1-build\.report\.md\)\.\n\nWhat changed: the key is issued\n$/,
  );
  assert.equal(ledgerOf(r.root, "T3").holds.at(-1).for, "blocked");

  blockedBy(out);
  lane(r, "report", "T3", "--agent", "builder-2");
  const same = lane(r, "resume", "T3", "--note", "issued now", "--same").json;
  assert.deepEqual([same.next, same.mode, same.agent], ["build", "resume", "builder-2"]);
});

test("a block inside step 2 holds and resumes on step 2: the step pointer and the verdict count do not move", () => {
  const r = repo();
  let out = lane(r, "start", "T1").json;
  build(out, "one.txt");
  lane(r, "report", "T1", "--agent", "builder-1");
  out = lane(r, "resume", "T1", "--note", "OK, go").json;
  blockedBy(out);
  assert.equal(lane(r, "report", "T1").exit, 0);
  const held = ledgerOf(r.root, "T1");
  assert.deepEqual([held.state, held.hold.for, held.hold.stepRun], ["held", "blocked", [2, 2]]);
  out = lane(r, "resume", "T1", "--note", "unblocked").json;
  const after = ledgerOf(r.root, "T1");
  assert.deepEqual(
    [out.next, after.rounds.at(-1).stepRun, after.rounds.filter((x) => x.verdict).length],
    ["continue", [2, 2], 0],
  );
  assert.match(readFileSync(out.brief, "utf8"), /## This round: step 2 of 2/);
});

test("fix --owner on a lane held for the owner is refused, naming resume --redo --note; nothing changes", () => {
  const r = repo();
  const out = lane(r, "start", "T1").json;
  build(out, "one.txt");
  assert.equal(lane(r, "report", "T1", "--agent", "builder-1").json.state, "held");
  const file = join(r.root, ".agentry", "run", "process", "ledger", "T1.json");
  const before = readFileSync(file, "utf8");
  const refused = lane(r, "fix", "T1", "--owner", "use two spaces");
  assert.equal(refused.exit, 2);
  assert.match(
    refused.stderr,
    /T1 is held \(owner\): its change goes in the resume, .*exec resume T1 --root '.*' --redo --note "<the change>"/,
  );
  assert.equal(readFileSync(file, "utf8"), before);
});

test("fix --owner on a blocked hold is refused naming resume --note, with no --redo", () => {
  const r = repo();
  blockedBy(lane(r, "start", "T3").json);
  lane(r, "report", "T3");
  const refused = lane(r, "fix", "T3", "--owner", "use two spaces");
  assert.equal(refused.exit, 2);
  assert.match(
    refused.stderr,
    /T3 is held \(blocked\): its change goes in the resume, .*exec resume T3 --root '[^']*' --note "<the change>"/,
  );
  assert.doesNotMatch(refused.stderr, /--redo/);
  assert.equal(ledgerOf(r.root, "T3").hold.for, "blocked");
});

test("a blocked fix round resumes as the same fix: its brief still points at the verifier's FAIL report", () => {
  const r = repo();
  let out = lane(r, "start", "T3").json;
  build(out, "three.txt");
  out = lane(r, "report", "T3", "--agent", "builder-1").json;
  const failPath = out.reportPath;
  writeFileSync(failPath, "three.txt is wrong\nused_memories: none\nVerdict: FAIL\n");
  out = lane(r, "verdict", "T3", "--agent", "verifier-1").json;
  assert.equal(out.next, "fix");
  const fixBrief = readFileSync(out.brief, "utf8");
  assert.ok(fixBrief.includes(`The verifier's FAIL is in ${failPath}.`));
  blockedBy(out);
  lane(r, "report", "T3", "--agent", "builder-1");
  const resumed = lane(r, "resume", "T3", "--note", "the key is issued");
  assert.equal(resumed.exit, 0, resumed.stderr);
  assert.deepEqual([resumed.json.next, resumed.json.mode], ["fix", "fresh"]);
  const again = readFileSync(resumed.json.brief, "utf8");
  assert.ok(again.includes(`The verifier's FAIL is in ${failPath}.`), again);
  assert.match(again, /What changed: the key is issued/);
});

test("a plain BLOCKED first line stops the lane even when a later line has the external form", () => {
  const r = repo();
  const out = lane(r, "start", "T3").json;
  writeFileSync(
    out.reportPath,
    "BLOCKED\nBLOCKED: external: none, the parser is broken\nused_memories: none\n",
  );
  assert.equal(lane(r, "report", "T3").exit, 1);
  assert.equal(ledgerOf(r.root, "T3").state, "stopped");
});

test("fix --owner on a parked verified lane is refused: resume it, then fix --owner", () => {
  const r = repo();
  verifiedLane(r);
  assert.equal(lane(r, "hold", "T3", "--for", "later").exit, 0);
  const file = join(r.root, ".agentry", "run", "process", "ledger", "T3.json");
  const before = readFileSync(file, "utf8");
  const refused = lane(r, "fix", "T3", "--owner", "use two spaces");
  assert.equal(refused.exit, 2);
  assert.match(
    refused.stderr,
    /T3 is parked verified: resume it \(.*exec resume T3 .*--note "<why>"\), then send the change with .*exec fix T3 .*--owner "<the change>"/,
  );
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(lane(r, "resume", "T3", "--note", "back").exit, 0);
  assert.equal(lane(r, "fix", "T3", "--owner", "use two spaces").exit, 0);
});

test("hold --for owner|later on a blocked hold is refused, the hold kept, so the resume still re-sends the round", () => {
  const r = repo();
  blockedBy(lane(r, "start", "T3").json);
  lane(r, "report", "T3");
  for (const who of ["owner", "later"]) {
    const refused = lane(r, "hold", "T3", "--for", who);
    assert.equal(refused.exit, 2);
    assert.match(refused.stderr, /T3 is held, blocked: clear it, then resume with --note/);
    assert.equal(ledgerOf(r.root, "T3").hold.for, "blocked");
  }
  assert.equal(lane(r, "resume", "T3", "--note", "cleared").json.next, "build");
});
