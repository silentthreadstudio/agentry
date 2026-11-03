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
    "ledgers",
    "mode",
    "prompt",
    "questions",
    "recall",
    "status",
  ]);
  assert.equal(data.mode, null);
  assert.deepEqual(data.ledgers, [{ id: "T1", state: "building", next: "report" }]);
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
  assert.match(res.stdout, /, \+\d+ more/);
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
    /^note: stale, every id it names is done \(T2\) → edit \.agentry\/NOTE\.md$/m,
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
  assert.match(res.stdout, /^note: stale, every id it names is done \(T2\)/m);
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
