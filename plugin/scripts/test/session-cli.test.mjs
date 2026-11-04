// Tests for `lane session start|close` (lib/lane/cli/session.mjs) on the drift fixture board: start shows
// the Now sprint, the nudges, the drafts and the mode in at most 40 lines; close gathers the drafts, the
// board-fix plan, the ledgers and what a sweep would clean, and writes nothing.
// Run: node --test plugin/scripts/test/session-cli.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as drafts from "../lib/process/drafts.mjs";
import { SPEC, boardRepo, builtBranch, handBranch, ledger, read } from "./drift-repo.mjs";
import { git, gitEnv } from "./git-repo.mjs";

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");
const home = mkdtempSync(join(tmpdir(), "session-home-"));
const cleanups = [];
after(() => {
  for (const c of cleanups) c();
});

function fresh() {
  const repo = boardRepo();
  cleanups.push(repo.cleanup);
  return repo.root;
}
const session = (root, ...args) =>
  spawnSync("node", [LANE, "session", ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, HOME: home, NO_COLOR: "1" },
  });

test("start prints the Now sprint, the nudges, the drafts and the mode in at most 40 lines", () => {
  const root = fresh();
  handBranch(root, "agent-tree", "worktree-agent-x");
  drafts.add(root, { kind: "decision", answer: "Use A", question: "A or B?" });
  mkdirSync(join(root, ".agentry"), { recursive: true });
  writeFileSync(join(root, ".agentry", "config.json"), JSON.stringify({ mode: "night" }));
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trimEnd().split("\n");
  assert.ok(lines.length <= 40, `${lines.length} lines`);
  assert.ok(lines.every((l) => [...l].length <= 80));
  assert.match(res.stdout, /session start · mode night/);
  assert.match(res.stdout, /^now: S1 0\/3$/m);
  assert.match(res.stdout, /in flight: T1 \(doing\), T3 \(verify\)/);
  assert.match(res.stdout, /drift: unlisted-worktree .*→ \/agentry:exec/);
  assert.match(res.stdout, /drafts: 1 pending → \/agentry:close/);
  assert.match(res.stdout, /conductor prompt: .*CONDUCTOR\.md/);
});

test("start puts the count before a long name, prints the note, and lists a question once", () => {
  const spec = structuredClone(SPEC);
  spec.kinds.sprint.fields.name = { column: "Name" };
  spec.kinds.question = {
    label: "Question",
    at: { table: "BOARD.md", heading: "Questions" },
    id: { column: "#" },
    fields: { question: { column: "Question" }, status: { column: "Status" } },
    status: { field: "status", values: { open: "active", answered: "done" } },
  };
  const repo = boardRepo({ spec });
  cleanups.push(repo.cleanup);
  const root = repo.root;
  const name = "A sprint whose name runs well past the end of an eighty column line";
  const sprints = "| Sprint | Status |\n| ------ | ------ |\n| S1     | doing  |";
  const md = read(root, "plan/BOARD.md")
    .replace(sprints, `| Sprint | Status | Name |\n| - | - | - |\n| S1 | doing | ${name} |`)
    .concat(
      "\n## Questions\n\n| # | Question | Status |\n| - | - | - |\n| Q1 | Ship it? | open |\n",
    );
  writeFileSync(join(root, "plan", "BOARD.md"), md);
  writeFileSync(join(root, ".agentry", "NOTE.md"), "# Note\n\nRead it first.\nThen the docs.\n");
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^now: S1 0\/3 · A sprint whose name .*…$/m);
  assert.match(res.stdout, /^note: Read it first\.$/m);
  assert.match(res.stdout, /^ {6}Then the docs\.$/m);
  assert.match(res.stdout, /^on you: .*Q1 \(open\)/m);
  assert.doesNotMatch(res.stdout, /open questions:/);
});

test("start nudges once when the hand status file lists a task the board finished", () => {
  const spec = { ...SPEC, status: { file: "STATUS.md", next: "Next" } };
  const repo = boardRepo({ spec });
  cleanups.push(repo.cleanup);
  const { root } = repo;
  const board = read(root, "plan/BOARD.md").replace(
    "| T2   | S1     | todo",
    "| T2   | S1     | done",
  );
  writeFileSync(join(root, "plan", "BOARD.md"), board);
  writeFileSync(join(root, "STATUS.md"), "## Next\n\n- T2 the second\n");
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split("\n").filter((l) => l.includes("stale-status"));
  assert.deepEqual(lines, ["drift: stale-status STATUS.md → edit STATUS.md: T2 done on the board"]);
});

test("start --json carries prompt, mode, status, recall, questions and ledgers", () => {
  const root = fresh();
  ledger(root, "T1");
  const data = JSON.parse(session(root, "start", "--json").stdout);
  assert.deepEqual(Object.keys(data).sort(), [
    "gateSlots",
    "held",
    "idle",
    "ledgers",
    "mergedToday",
    "mode",
    "prompt",
    "questions",
    "recall",
    "status",
  ]);
  assert.equal(data.mode, null);
  assert.deepEqual(data.ledgers, [
    { id: "T1", state: "building", next: "report", on: null, restack: null },
  ]);
  assert.equal(data.mergedToday, 0);
});

test("lanes: lists the open lanes only, then how many merged today; --json keeps every ledger", () => {
  const root = fresh();
  const merged = (id, at) => ledger(root, id, { state: "merged", next: null, merge: { at } });
  ledger(root, "B1");
  merged("M1", new Date().toISOString());
  merged("M2", new Date(Date.now() - 2 * 86_400_000).toISOString());
  merged("M3", undefined);
  ledger(root, "C1", { state: "closed", next: null });
  const lines = session(root, "start").stdout.split("\n");
  assert.deepEqual(
    lines.filter((l) => l.startsWith("lanes: ")),
    ["lanes: B1 building · 1 merged today"],
  );
  const data = JSON.parse(session(root, "start", "--json").stdout);
  assert.equal(data.mergedToday, 1, "a merge from another day, or with no time, is not today's");
  assert.deepEqual(
    data.ledgers.map((l) => l.id),
    ["B1", "M1", "M2", "M3"],
  );

  const quiet = fresh();
  ledger(quiet, "M1", { state: "merged", next: null, merge: { at: new Date().toISOString() } });
  assert.match(session(quiet, "start").stdout, /^lanes: none open · 1 merged today$/m);
});

test("start shows a stacked lane on its parent and a line per due stack, at most 3, then the count", () => {
  const root = fresh();
  const main = git(root, "rev-parse", "main");
  for (const id of ["P1", "P3"]) git(root, "branch", `agentry/${id}`, "main");
  ledger(root, "P1", { state: "verified", next: "merge" });
  ledger(root, "P2", { state: "merged", next: null, merge: { at: "2026-01-01T00:00:00.000Z" } });
  ledger(root, "P3", { state: "stopped", next: "stop" });
  ledger(root, "S1", { on: "P1", base: main }); // on P1's tip: nothing due
  ledger(root, "S2", { on: "P1", base: "0".repeat(40) }); // P1 moved
  ledger(root, "S3", { on: "P2", base: main }); // P2 landed
  ledger(root, "S4", { on: "P3", base: main }); // P3 is stopped
  ledger(root, "S5", { on: "P1", base: "1".repeat(40) }); // P1 moved, past the cap
  const lines = session(root, "start").stdout.trimEnd().split("\n");
  const at = lines.findIndex((l) => l.startsWith("lanes: "));
  const lanes = lines.slice(
    at,
    lines.findIndex((l, i) => i > at && !l.startsWith("  ")),
  );
  assert.match(lanes.join(" "), /S1 building on P1, S2 building on P1/);
  assert.doesNotMatch(lanes.join(" "), /P1 verified on/);
  assert.deepEqual(
    lines.filter((l) => l.startsWith("stack: ")),
    [
      "stack: S2 on P1: P1 moved → lane exec restack S2",
      "stack: S3 on P2: P2 landed → lane exec restack S3",
      "stack: S4 on P3: P3 is stopped → lane exec restack S4",
      "stack: +1 more → lane session start --json",
    ],
  );
  assert.ok(
    lines.findIndex((l) => l.startsWith("stack: ")) > at,
    "the stack lines come after lanes:",
  );
  const data = JSON.parse(session(root, "start", "--json").stdout);
  const by = Object.fromEntries(data.ledgers.map((l) => [l.id, [l.on, l.restack]]));
  assert.deepEqual(by, {
    P1: [null, null],
    P2: [null, null],
    P3: [null, null],
    S1: ["P1", null],
    S2: ["P1", "parent"],
    S3: ["P2", "main"],
    S4: ["P3", "orphan"],
    S5: ["P1", "parent"],
  });
});

test("start ranks this repo's remembered facts against the work in flight", () => {
  const root = fresh();
  const dir = join(root, ".agentry", "memory", "facts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "f1.md"),
    "---\nid: f1\ntype: gotcha\nscope: repo\nstatus: active\nconfidence: 0.9\ntags:\n  - first\n---\nThe first task needs its cache cleared.\n",
  );
  const data = JSON.parse(session(root, "start", "--json").stdout);
  assert.equal(data.recall[0].id, "f1");
});

test("close gathers drafts, the fix plan, ledgers and sweep findings, and writes nothing", () => {
  const root = fresh();
  drafts.add(root, { kind: "rule", answer: "Always X" });
  const built = builtBranch(root, "T1");
  git(root, "cherry-pick", built.sha);
  // board fix writes done only from a `lane merge` record (A23), so the fixture carries one.
  const landed = git(root, "rev-parse", "HEAD");
  const preHead = git(root, "rev-parse", `${landed}^`);
  const merge = { preHead, planned: [built.sha], landed: [landed] };
  ledger(root, "T1", { state: "merged", worktree: built.path, merge });
  ledger(root, "T3", { episode: { payload: {} } });
  ledger(root, "T5", { state: "stopped" });
  const before = read(root, "plan/BOARD.md");
  const res = session(root, "close");
  assert.equal(res.status, 0, res.stderr);
  const data = JSON.parse(res.stdout);
  assert.equal(data.drafts.length, 1);
  assert.equal(data.fixPlan.applied, false);
  assert.equal(data.fixPlan.fixed[0].id, "T1");
  assert.deepEqual(
    data.cleanable.map((w) => w.id),
    ["T1"],
  );
  // T1 merged and T5 stopped without an episode, T3 with a payload nobody wrote.
  assert.deepEqual(data.episodesPending.sort(), ["T1", "T3", "T5"]);
  assert.deepEqual(data.strays, []);
  assert.deepEqual(data.leftAlone, []);
  assert.equal(typeof data.diskFree, "number");
  assert.equal(read(root, "plan/BOARD.md"), before);
});

test("a missing or unknown step is a usage error", () => {
  const root = fresh();
  assert.equal(session(root).status, 2);
  assert.equal(session(root, "later").status, 2);
});

test("a long lanes list wraps and counts what it drops instead of cutting it mid-line", () => {
  const root = fresh();
  for (let i = 1; i <= 30; i++) ledger(root, `LANE-${String(i).padStart(2, "0")}`);
  const res = session(root, "start");
  const lines = res.stdout.trimEnd().split("\n");
  assert.ok(lines.length <= 40 && lines.every((l) => [...l].length <= 80));
  const at = lines.findIndex((l) => l.startsWith("lanes: "));
  assert.ok(lines[at + 1].startsWith("  LANE-"), "the list continues on the next line");
  assert.match(res.stdout, /, \+\d+ more · 0 merged today$/m);
  assert.ok(lines.slice(at).join(" ").includes("LANE-01 building"));
});

test("a primeLimit of 0 falls back to the default instead of recalling nothing", () => {
  const root = fresh();
  const dir = join(root, ".agentry", "memory", "facts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "f1.md"),
    "---\nid: f1\ntype: gotcha\nscope: repo\nstatus: active\nconfidence: 0.9\ntags:\n  - first\n---\nThe first task needs its cache cleared.\n",
  );
  writeFileSync(
    join(root, ".agentry", "config.json"),
    JSON.stringify({ memory: { primeLimit: 0 }, mode: "night" }),
  );
  const data = JSON.parse(session(root, "start", "--json").stdout);
  assert.equal(data.recall[0]?.id, "f1");
  assert.equal(data.mode, "night");
});

test("a wrapped list line that ends exactly at the width keeps its comma and hides no item", () => {
  const root = fresh();
  // "lanes: " + 26 + " building" + ", " + 27 + " building" is exactly 80 columns before the comma.
  const ids = ["A".repeat(26), "B".repeat(27), "C".repeat(5)];
  for (const id of ids) ledger(root, id);
  const lines = session(root, "start").stdout.trimEnd().split("\n");
  assert.ok(lines.every((l) => [...l].length <= 80));
  const text = lines.join("\n");
  for (const id of ids) assert.ok(text.includes(`${id} building`), `${id[0]} is listed`);
  assert.ok(!text.includes("…"), "no line was cut");
});

test("a config the reader refuses is said at start, not shown as no mode", () => {
  const root = fresh();
  mkdirSync(join(root, ".agentry"), { recursive: true });
  writeFileSync(join(root, ".agentry", "config.json"), JSON.stringify({ mode: "" }));
  const res = session(root, "start");
  assert.match(res.stdout, /mode unreadable/);
  assert.doesNotMatch(res.stdout, /none set/);
  assert.match(res.stdout, /config: .*mode should be a non-empty string/);
  const data = JSON.parse(session(root, "start", "--json").stdout);
  assert.match(data.configError, /mode should be a non-empty string/);
});

test("start flags the note stale when every id it names is done, and not while one is open", () => {
  const repo = boardRepo();
  cleanups.push(repo.cleanup);
  const { root } = repo;
  const board = read(root, "plan/BOARD.md").replace(
    "| T2   | S1     | todo",
    "| T2   | S1     | done",
  );
  writeFileSync(join(root, "plan", "BOARD.md"), board);
  const note = join(root, ".agentry", "NOTE.md");
  writeFileSync(note, "# Note\n\nWatch T2 land.\n");
  const stale = session(root, "start");
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(
    stale.stdout,
    /^note: stale, every id it names is done → edit \.agentry\/NOTE\.md \(T2\)$/m,
  );
  writeFileSync(note, "# Note\n\nWatch T2 and T1 land.\n");
  assert.doesNotMatch(session(root, "start").stdout, /note: stale/);
  writeFileSync(note, "# Note\n\nNo ids here.\n");
  assert.doesNotMatch(session(root, "start").stdout, /note: stale/);
});

test("a bare number in the note is no id: it does not hide a stale note", () => {
  const spec = structuredClone(SPEC);
  spec.kinds.decision = {
    label: "Decision",
    at: { table: "BOARD.md", heading: "Decisions" },
    id: { column: "#" },
    fields: { decision: { column: "Decision" } },
  };
  const repo = boardRepo({ spec });
  cleanups.push(repo.cleanup);
  const { root } = repo;
  writeFileSync(
    join(root, "plan", "BOARD.md"),
    read(root, "plan/BOARD.md")
      .replace("| T2   | S1     | todo", "| T2   | S1     | done")
      .concat("\n## Decisions\n\n| # | Decision |\n| - | - |\n| 2 | Use files |\n"),
  );
  writeFileSync(join(root, ".agentry", "NOTE.md"), "# Note\n\nT2 merged; step 2 next.\n");
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^note: stale, every id it names is done → edit [^\n]* \(T2\)$/m);
});

test("start lists the gate slots a running gate holds, and none when they are free", () => {
  const root = fresh();
  assert.doesNotMatch(session(root, "start").stdout, /^gate:/m);
  const locks = join(root, ".agentry", "run", "gate-locks");
  mkdirSync(locks, { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(
    join(locks, "slot-1.lock"),
    JSON.stringify({ pid: process.pid, who: "lane T1", at }),
  );
  const dead = spawnSync(process.execPath, ["-e", "0"]);
  writeFileSync(join(locks, "slot-2.lock"), JSON.stringify({ pid: dead.pid, who: "lane T2", at }));
  const res = session(root, "start");
  assert.match(res.stdout, /^gate: slot 1 held by lane T1 since \d\d:\d\d$/m);
  assert.doesNotMatch(res.stdout, /T2/);
  const data = JSON.parse(session(root, "start", "--json").stdout);
  assert.deepEqual(
    data.gateSlots.map((g) => [g.slot, g.who, g.pid]),
    [[1, "lane T1", process.pid]],
  );
});

test("start counts the gate slots that do not fit on the line, and never cuts one", () => {
  const root = fresh();
  const locks = join(root, ".agentry", "run", "gate-locks");
  mkdirSync(locks, { recursive: true });
  const at = new Date().toISOString();
  const hold = (n) =>
    writeFileSync(
      join(locks, `slot-${n}.lock`),
      JSON.stringify({ pid: process.pid, who: `lane T${n}`, at }),
    );
  for (const n of [1, 2, 3]) hold(n);
  const three = session(root, "start").stdout;
  for (const n of [1, 2, 3]) assert.match(three, new RegExp(`slot ${n} held by lane T${n} since`));
  assert.doesNotMatch(three, /more/);
  for (let n = 4; n <= 12; n++) hold(n);
  const many = session(root, "start").stdout;
  assert.match(many, /^ {2}slot \d+ held by .*, \+\d+ more$/m);
  assert.ok(many.split("\n").every((l) => [...l].length <= 80));
});

// A held ledger: for the owner after step 1 of 2, or parked (`for: "later"`).
const SINCE = "2026-11-03T09:05:00.000Z";
const hhmm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
function heldLedger(root, id, hold = {}) {
  ledger(root, id, {
    state: "held",
    next: "resume",
    steps: [
      { n: 1, text: "a", gate: "owner", accept: [] },
      { n: 2, text: "b", gate: null, accept: [] },
    ],
    hold: {
      for: "owner",
      when: "after",
      stepRun: [1, 1],
      evidence: join(root, ".agentry", "run", "process", "runs", id, "r1-build.report.md"),
      since: SINCE,
      round: 1,
      ...hold,
    },
  });
}

test("start prints each held lane after the prompt line and before now:, and leaves it out of lanes:", () => {
  const root = fresh();
  heldLedger(root, "H1");
  heldLedger(root, "P1", { for: "later", when: "during", evidence: null });
  ledger(root, "B1");
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split("\n");
  const at = lines.findIndex((l) => l.startsWith("conductor prompt:"));
  assert.deepEqual(lines.slice(at + 1, at + 4), [
    `held: H1 for the owner, after step 1 of 2, since ${hhmm(SINCE)}`,
    "  evidence: .agentry/run/process/runs/H1/r1-build.report.md",
    '  → lane exec resume H1 --note "<the OK>"',
  ]);
  assert.deepEqual(lines.slice(at + 4, at + 6), [
    `parked: P1 since ${hhmm(SINCE)}`,
    '  → lane exec resume P1 --note "<the OK>"',
  ]);
  assert.match(lines[at + 6], /^now: /);
  const lanes = lines.find((l) => l.startsWith("lanes: "));
  assert.equal(lanes, "lanes: B1 building · 0 merged today");

  const data = JSON.parse(session(root, "start", "--json").stdout);
  assert.deepEqual(data.held[0], {
    id: "H1",
    for: "owner",
    when: "after",
    steps: "step 1 of 2",
    since: SINCE,
    evidence: ".agentry/run/process/runs/H1/r1-build.report.md",
    resume: 'lane exec resume H1 --note "<the OK>"',
  });
  assert.deepEqual(
    data.held.map((h) => [h.id, h.for]),
    [
      ["H1", "owner"],
      ["P1", "later"],
    ],
  );
  assert.deepEqual(
    data.ledgers.map((l) => l.id),
    ["H1", "P1", "B1"],
    "held ledgers first",
  );
});

test("a parked lane prints its note, its evidence when the hold has one, and the resume (field 62)", () => {
  const root = fresh();
  const evidence = join(root, ".agentry", "run", "process", "runs", "P1", "notes.md");
  heldLedger(root, "P1", { for: "later", when: "during", evidence, why: "waits for\nthe API" });
  heldLedger(root, "P2", { for: "later", when: "verified", evidence: null });
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split("\n");
  const at = lines.findIndex((l) => l.startsWith("parked: P1"));
  assert.deepEqual(lines.slice(at, at + 5), [
    `parked: P1 since ${hhmm(SINCE)}: "waits for the API"`,
    "  evidence: .agentry/run/process/runs/P1/notes.md",
    '  → lane exec resume P1 --note "<the OK>"',
    `parked: P2 since ${hhmm(SINCE)}`,
    '  → lane exec resume P2 --note "<the OK>"',
  ]);
});

test("parked and held lanes share the cap of 3: the fourth is counted", () => {
  const root = fresh();
  heldLedger(root, "H1");
  for (const id of ["P1", "P2", "P3"]) heldLedger(root, id, { for: "later", evidence: null });
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  const rows = res.stdout.split("\n").filter((l) => /^(held|parked): /.test(l));
  assert.deepEqual(
    rows.map((l) => l.split(" ").slice(0, 2).join(" ")),
    ["held: H1", "parked: P1", "parked: P2", "held: +1"],
  );
});

test("start prints a guard hold with its reason and the report step, never the resume line (field 75)", () => {
  const root = fresh();
  heldLedger(root, "G1", {
    for: "guard",
    when: "during",
    stepRun: null,
    reason: "HEAD moved 1234567 → 89abcde",
    report: join(root, ".agentry", "run", "process", "runs", "G1", "r1-build.report.held.md"),
  });
  for (const id of ["H1", "H2", "H3"]) heldLedger(root, id);
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split("\n");
  const at = lines.indexOf(`held: G1 guard tripped, since ${hhmm(SINCE)}`);
  assert.ok(at > 0, res.stdout);
  assert.deepEqual(lines.slice(at + 1, at + 3), [
    "  reason: HEAD moved 1234567 → 89abcde",
    `  → lane exec report G1 --root '${root}' (after fixing it)`,
  ]);
  assert.doesNotMatch(res.stdout, /exec resume G1/);
  const held = lines.filter((l) => l.startsWith("held: "));
  assert.equal(held.length, 4, "the guard hold shares the cap of three");
  assert.equal(held.at(-1), "held: +1 more → lane session start --json");
  const data = JSON.parse(session(root, "start", "--json").stdout).held.find((h) => h.id === "G1");
  assert.deepEqual(
    [data.for, data.reason, data.resume],
    ["guard", "HEAD moved 1234567 → 89abcde", undefined],
  );
});

test("start shows three held lanes and counts the fourth", () => {
  const root = fresh();
  for (const id of ["H1", "H2", "H3", "H4"]) heldLedger(root, id);
  const res = session(root, "start");
  assert.equal(res.status, 0, res.stderr);
  const held = res.stdout.split("\n").filter((l) => l.startsWith("held: "));
  assert.equal(held.length, 4);
  assert.equal(held[3], "held: +1 more → lane session start --json");
  assert.doesNotMatch(res.stdout, /^lanes: /m);
  assert.equal(JSON.parse(session(root, "start", "--json").stdout).held.length, 4);
});

// --- session checks (A42): extensions.start.checks and extensions.close.checks ----------------------------

const CHECKS_FILE = ".agentry/run/process/session-checks.jsonl";
// A repo naming `extensions` in its workflow file, holding the SKILL.md of each skill in `skills`.
function checkedRepo(extensions, skills = ["repo-session"]) {
  const repo = boardRepo({ spec: { ...SPEC, extensions } });
  cleanups.push(repo.cleanup);
  for (const s of skills) {
    mkdirSync(join(repo.root, ".claude", "skills", s), { recursive: true });
    writeFileSync(join(repo.root, ".claude", "skills", s, "SKILL.md"), "# s\n");
  }
  return repo.root;
}
const BOTH = {
  start: { checks: ["repo-session"] },
  close: { checks: ["repo-session", "repo-ui"] },
};
const entries = (root) =>
  read(root, CHECKS_FILE)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test("with no check named, start prints and carries nothing about checks", () => {
  const root = fresh();
  assert.doesNotMatch(session(root, "start").stdout, /checks:|last close:/);
  assert.equal(Object.hasOwn(JSON.parse(session(root, "start", "--json").stdout), "checks"), false);
  assert.equal(Object.hasOwn(JSON.parse(session(root, "close").stdout), "checks"), false);
});

test("start lists the checks to run right after the prompt line, before the held lanes", () => {
  const root = checkedRepo(BOTH);
  ledger(root, "T1", {
    state: "held",
    hold: { for: "later", when: "building", since: new Date().toISOString() },
  });
  const lines = session(root, "start").stdout.split("\n");
  const at = lines.findIndex((l) => l.startsWith("conductor prompt:"));
  assert.equal(lines[at + 1], "start checks: repo-session (run each, then record it)");
  assert.match(
    lines[at + 2],
    /^ {2}→ .*lane session start --check <skill>=pass\|fail --note "<line>"$/,
  );
  assert.match(lines[at + 3], /^parked: T1/);
});

test("start says a named skill with no SKILL.md has none", () => {
  const root = checkedRepo({ start: { checks: ["repo-session", "ghost"] } });
  const { stdout } = session(root, "start");
  assert.match(stdout, /^start checks: repo-session, ghost \(run each, then record it\)$/m);
  assert.match(
    stdout,
    /^start checks: ghost has no \.claude\/skills\/ghost\/SKILL\.md\n {2}→ \/agentry:init$/m,
  );
  const data = JSON.parse(session(root, "start", "--json").stdout);
  assert.deepEqual(data.checks.start.missing, ["ghost"]);
  assert.deepEqual(data.checks.close, {
    named: [],
    recorded: [],
    pending: [],
    failed: [],
    missing: [],
  });
});

test("--check records one entry and prints the outcome with the counts", () => {
  const root = checkedRepo(BOTH, ["repo-session", "repo-ui"]);
  const pass = session(root, "close", "--check", "repo-session=pass");
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(
    pass.stdout.trimEnd(),
    "✓ close check repo-session: pass\nclose checks: 1/2 recorded · pending: repo-ui",
  );
  const fail = session(root, "close", "--check", "repo-ui=fail", "--note", "screens\nare red");
  assert.equal(
    fail.stdout.trimEnd(),
    "✗ close check repo-ui: fail · screens are red\nclose checks: 2/2 recorded · failed: repo-ui",
  );
  const [first, second] = entries(root);
  assert.deepEqual(
    [first.phase, first.skill, first.result, first.note],
    ["close", "repo-session", "pass", undefined],
  );
  assert.equal(second.note, "screens\nare red", "the note is stored whole");
  assert.ok(!Number.isNaN(Date.parse(second.at)));
});

test("--check --json carries the entry and the counts", () => {
  const root = checkedRepo(BOTH);
  const data = JSON.parse(
    session(root, "start", "--check", "repo-session=fail", "--note", "red", "--json").stdout,
  );
  const { at, ...rest } = data;
  assert.ok(at);
  assert.deepEqual(rest, {
    phase: "start",
    skill: "repo-session",
    result: "fail",
    note: "red",
    recorded: 1,
    total: 1,
    pending: [],
    failed: ["repo-session"],
  });
});

test("--check from a lane worktree writes the main checkout's record", () => {
  const root = checkedRepo(BOTH);
  const built = builtBranch(root, "T1");
  mkdirSync(join(built.path, ".claude", "skills", "repo-session"), { recursive: true });
  writeFileSync(join(built.path, ".claude", "skills", "repo-session", "SKILL.md"), "# s\n");
  const res = session(built.path, "start", "--check", "repo-session=pass");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(entries(root).length, 1);
  assert.throws(() => read(built.path, CHECKS_FILE), { code: "ENOENT" });
});

test("--check refuses a skill the phase does not name, and one with no SKILL.md", () => {
  const root = checkedRepo({ ...BOTH, close: { checks: ["repo-session", "ghost"] } });
  const other = session(root, "start", "--check", "repo-ui=pass");
  assert.equal(other.status, 2);
  assert.equal(
    other.stderr.trimEnd(),
    '✗ lane session start --check: "repo-ui" is not in extensions.start.checks (repo-session)',
  );
  const none = session(
    checkedRepo({ close: { checks: ["repo-session"] } }),
    "start",
    "--check",
    "a=pass",
  );
  assert.match(none.stderr, /\(none named\)\n$/);
  const ghost = session(root, "close", "--check", "ghost=pass");
  assert.equal(ghost.status, 2);
  assert.equal(
    ghost.stderr.trimEnd(),
    '✗ lane session close --check: extensions.close.checks names "ghost", but .claude/skills/ghost/SKILL.md is missing',
  );
  assert.throws(() => read(root, CHECKS_FILE), { code: "ENOENT" });
});

test("--check takes exactly <skill>=pass|fail, and --note goes with it", () => {
  const root = checkedRepo(BOTH);
  for (const bad of [
    "repo-session",
    "repo-session=PASS",
    "=pass",
    "repo-session=pass=pass",
    "repo-session=ok",
  ])
    assert.equal(session(root, "start", "--check", bad).status, 2, bad);
  const note = session(root, "start", "--note", "alone");
  assert.equal(note.status, 2);
  assert.match(note.stderr, /--note goes with --check/);
  assert.throws(() => read(root, CHECKS_FILE), { code: "ENOENT" });
});

test("start shows how the last close went, cuts a note to one line, and a start check ends it", () => {
  const root = checkedRepo({ ...BOTH, close: { checks: ["a", "b", "c", "d", "e"] } }, [
    "repo-session",
    "a",
    "b",
    "c",
    "d",
    "e",
  ]);
  session(root, "close", "--check", "a=pass");
  for (const s of ["b", "c", "d", "e"])
    session(
      root,
      "close",
      "--check",
      `${s}=fail`,
      "--note",
      `${s} is red\nsecond line ${"x".repeat(120)}`,
    );
  const lines = session(root, "start").stdout.split("\n");
  const last = lines.filter((l) => l.startsWith("last close: "));
  assert.match(last[0], /^last close: 1\/5 passed \(\d{4}-\d\d-\d\dT\d\d:\d\dZ\)$/);
  assert.equal(last.length, 5);
  assert.match(last[1], /^last close: b failed · b is red second line x+…$/);
  assert.equal([...last[1]].length, 100);
  assert.equal(last[4], "last close: +1 more failed");
  const data = JSON.parse(session(root, "start", "--json").stdout);
  assert.equal(data.checks.close.recorded.length, 5);
  session(root, "start", "--check", "repo-session=pass");
  assert.doesNotMatch(session(root, "start").stdout, /last close:/);
});

test("close carries checks and still writes nothing without --check", () => {
  const root = checkedRepo(BOTH);
  const data = JSON.parse(session(root, "close").stdout);
  assert.deepEqual(data.checks.close.pending, ["repo-session", "repo-ui"]);
  assert.deepEqual(data.checks.close.missing, ["repo-ui"]);
  assert.throws(() => read(root, CHECKS_FILE), { code: "ENOENT" });
});

test("the missing-skill pointer is on its own line, whole, for the doc's example name", () => {
  const root = checkedRepo({ start: { checks: ["repo-session"] } }, []);
  const lines = session(root, "start").stdout.split("\n");
  const at = lines.findIndex((l) => l.startsWith("start checks: repo-session has no "));
  assert.ok(at >= 0);
  assert.equal(lines[at], "start checks: repo-session has no .claude/skills/repo-session/SKILL.md");
  assert.equal(lines[at + 1], "  → /agentry:init");
});

test("a record the run cannot use exits 2 with one line naming it, for start, close and --check", () => {
  const root = checkedRepo(BOTH, ["repo-session", "repo-ui"]);
  mkdirSync(join(root, CHECKS_FILE), { recursive: true });
  for (const args of [
    ["start"],
    ["start", "--json"],
    ["close"],
    ["close", "--check", "repo-ui=pass"],
  ]) {
    const res = session(root, ...args);
    assert.equal(res.status, 2, args.join(" "));
    const lines = res.stderr.trimEnd().split("\n");
    assert.equal(lines.length, 1, res.stderr);
    assert.match(lines[0], /^✗ lane session: cannot use .*session-checks\.jsonl: EISDIR/);
  }
});
