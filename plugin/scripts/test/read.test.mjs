// Tests for lib/process/read.mjs — process file + synthetic board files → Model (plan F13 §6).
// Fixtures (test/fixtures/, invented content): table-board (a row per task with its own flag, verdict
// and commit), evidence-board (one free-text evidence column, multi-kind deps), frontmatter-board
// (one file per item), broken (a spec and a board that no longer match).
// Run: node --test plugin/scripts/test/read.test.mjs
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { splitRow } from "../lib/process/markdown.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function model(name, root = join(FIXTURES, name)) {
  const { spec, problems } = loadSpec(join(root, "process.json"));
  assert.deepEqual(problems, [], `${name}: the spec is valid`);
  return readProcess({ root, spec });
}
const item = (m, kind, id) => m.kinds[kind].items.find((i) => i.id === id);

/** A scratch copy of a fixture, with `edit(text)` applied to one of its files. */
function copyWith(name, file, edit) {
  const root = mkdtempSync(join(tmpdir(), "agentry-read-"));
  temps.push(root);
  cpSync(join(FIXTURES, name), root, { recursive: true });
  writeFileSync(join(root, file), edit(readFileSync(join(root, file), "utf8")));
  return root;
}

test("table board: every kind is located, with no load problems", () => {
  const m = model("table-board");
  assert.deepEqual(m.problems, []);
  const counts = Object.fromEntries(Object.entries(m.kinds).map(([k, v]) => [k, v.items.length]));
  assert.deepEqual(counts, { milestone: 2, sprint: 6, task: 8, question: 2, decision: 2 });
  assert.ok(Object.values(m.kinds).every((k) => k.located));
});

test("table board: cells are read by header name, stripped and typed", () => {
  const m = model("table-board");
  assert.deepEqual(item(m, "task", "W1").fields, {
    sprint: "A1",
    status: "done",
    deps: [],
    risky: true,
    verdict: "PASS",
    commit: ["a1b2c3d"],
    note: "The loop, headless",
  });
  const w3 = item(m, "task", "W3");
  assert.ok(w3, "**W3** reads as W3");
  assert.deepEqual(w3.fields.deps, ["W1", "W2"]);
  assert.equal(w3.fields.verdict, "PASS WITH NOTES", "case: upper");
  assert.deepEqual(item(m, "task", "W2").fields.commit, ["b2c3d4e", "0f9e8d7"]);
  assert.equal(item(m, "task", "W2").fields.note, "loop.mjs split in two", "backticks stripped");
  assert.equal(item(m, "task", "W5").fields.note, "The door | the hinge");
  assert.equal(item(m, "sprint", "A1").fields.name, "The loop", "link text");
  assert.equal(item(m, "sprint", "PRE").fields.name, "Work merged before this board", "no link");
  assert.equal(item(m, "sprint", "A1").fields.ok, "2026-01-12");
  assert.equal(item(m, "sprint", "A2").fields.ok, null);
  const m1 = item(m, "milestone", "M1");
  assert.equal(m1.fields.name, "First light", "match group");
  assert.deepEqual(m1.fields.sprints, ["A1", "A2"]);
  assert.deepEqual(
    m.kinds.decision.items.map((d) => d.id),
    ["1", "2"],
  );
});

test("table board: items carry status, phase, file and line", () => {
  const m = model("table-board");
  const w1 = item(m, "task", "W1");
  assert.equal(w1.status, "done");
  assert.equal(w1.phase, "done");
  assert.equal(w1.file, "BOARD.md");
  assert.equal(w1.line, 29);
  assert.equal(item(m, "task", "W9").phase, "parked");
  assert.equal(item(m, "decision", "1").file, "../DECISIONS.md");
});

test("a shuffled column order reads the same items", () => {
  const reverseTasks = (text) => {
    const lines = text.split("\n");
    const start = lines.indexOf("## Tasks") + 2;
    const escapePipes = (cell) => cell.replaceAll("|", "\\|");
    for (let i = start; lines[i]?.startsWith("|"); i++)
      lines[i] = `| ${splitRow(lines[i]).toReversed().map(escapePipes).join(" | ")} |`;
    return lines.join("\n");
  };
  const shuffled = model(
    "table-board",
    copyWith("table-board", "docs/board/BOARD.md", reverseTasks),
  );
  assert.ok(
    readFileSync(join(shuffled.root, "docs/board/BOARD.md"), "utf8").includes("| Note | Commit |"),
  );
  assert.deepEqual(shuffled.kinds.task.items, model("table-board").kinds.task.items);
});

test("headings in the process file may carry their # marks", () => {
  const root = join(FIXTURES, "table-board");
  const { spec } = loadSpec(join(root, "process.json"));
  for (const kind of Object.values(spec.kinds))
    if (kind.at.heading)
      kind.at.heading = `${kind.at.heading === "Decisions log" ? "#" : "##"} ${kind.at.heading}`;
  for (const def of Object.values(spec.kinds.sprint.file.sections))
    def.heading = `##  ${def.heading}`;
  const marked = readProcess({ root, spec });
  assert.deepEqual(marked.problems, []);
  assert.deepEqual(marked.kinds, model("table-board").kinds);
});

test("derived: children gives a milestone its phase from its sprints", () => {
  const m = model("table-board");
  assert.equal(item(m, "milestone", "M1").phase, "active", "A1 done + A2 doing");
  assert.equal(item(m, "milestone", "M2").phase, "planned", "B1 todo");
  assert.equal(item(m, "milestone", "M1").status, undefined, "no status column");
  const allDone = (text) =>
    text.replace(
      "| A2 | [The evening](sprints/A2_the_evening.md) | doing |",
      "| A2 | [The evening](sprints/A2_the_evening.md) | done |",
    );
  const done = model("table-board", copyWith("table-board", "docs/board/BOARD.md", allDone));
  assert.equal(item(done, "milestone", "M1").phase, "done", "every sprint closed");
});

test("the tree: parent refs and children lists link across kinds", () => {
  const m = model("table-board");
  assert.equal(item(m, "task", "W3").parent, "A2");
  assert.deepEqual(item(m, "sprint", "A1").children, ["W1", "W2"]);
  assert.equal(item(m, "sprint", "A1").parent, "M1", "from the milestone's Sprints list");
  assert.deepEqual(item(m, "milestone", "M1").children, ["A1", "A2"]);
});

test("ranks: a sprint's row order; a task takes its sprint's; a milestone its last sprint's", () => {
  const m = model("table-board");
  assert.deepEqual(
    m.kinds.sprint.items.map((s) => [s.id, s.rank]),
    [
      ["PRE", 0],
      ["A1", 1],
      ["A2", 2],
      ["B1", 3],
      ["TRK", 4],
      ["LATER", 5],
    ],
  );
  assert.equal(item(m, "task", "W4").rank, 2);
  assert.equal(item(m, "milestone", "M1").rank, 2);
  assert.equal(item(m, "question", "Q-01").rank, undefined, "outside the tree");
});

test("sprint files by glob, except listed ids; sections as table and bold-lead", () => {
  const m = model("table-board");
  for (const id of ["PRE", "TRK", "LATER"]) assert.equal(item(m, "sprint", id).own, undefined, id);
  const a1 = item(m, "sprint", "A1").own;
  assert.equal(a1.path, "sprints/A1_the_loop.md");
  assert.deepEqual(a1.matches, ["sprints/A1_the_loop.md"]);
  assert.deepEqual(
    a1.sections.members.rows.map((r) => [r.Task, r.What]),
    [
      ["W1", "The loop, headless"],
      ["W2", "Split the loop module"],
    ],
  );
  assert.deepEqual(
    a1.sections.handoff.leads.map((l) => [l.ids, l.commits]),
    [
      [["W1"], ["a1b2c3d"]],
      [["W2"], ["b2c3d4e", "0f9e8d7"]],
    ],
  );
  const a2 = item(m, "sprint", "A2").own.sections;
  assert.deepEqual(
    a2.members.rows.map((r) => r.Task),
    ["W3", "W4"],
    "header-named, shuffled",
  );
  assert.deepEqual(a2.handoff.leads, [], "a heading with prose only");
});

test("evidence board: evidence is SHAs plus one note token", () => {
  const m = model("evidence-board");
  assert.deepEqual(m.problems, []);
  assert.deepEqual(item(m, "task", "K0-1").fields.evidence, ["1a2b3c4"]);
  assert.deepEqual(item(m, "task", "K0-2").fields.evidence, ["moved 2026-02-01; links updated"]);
  assert.deepEqual(item(m, "task", "K0-3").fields.evidence, [
    "2b3c4d5",
    "3c4d5e6",
    "verifier PASS WITH NOTES",
  ]);
});

test("evidence board: multi-kind refs resolve through the index", () => {
  const m = model("evidence-board");
  assert.deepEqual(item(m, "task", "H2").fields.deps, ["K0", "H1"]);
  assert.deepEqual(
    m.index.K0.map((i) => i.kind),
    ["milestone", "sprint"],
    "an id two kinds share is in the index under both",
  );
  assert.deepEqual(
    m.index.K1.map((i) => i.kind),
    ["milestone"],
  );
  assert.equal(m.index.H1[0], item(m, "task", "H1"));
});

test("evidence board: an `also` literal parent stays as written, outside the tree", () => {
  const m = model("evidence-board");
  const h8 = item(m, "task", "H8");
  assert.equal(h8.parent, "LATER");
  assert.equal(h8.rank, undefined);
  assert.equal(m.index.LATER, undefined, "LATER is not an item");
});

test("evidence board: optional sprint files; bold-lead members and combined handoff leads", () => {
  const m = model("evidence-board");
  assert.equal(item(m, "sprint", "K1a").own, undefined, "required: false, no file, no problem");
  const { members, handoff } = item(m, "sprint", "K0").own.sections;
  assert.deepEqual(
    members.leads.map((l) => l.lead),
    ["K0-1", "K0-2", "K0-3", "K0-4"],
  );
  const named = (id) => handoff.leads.filter((l) => l.ids.includes(id)).map((l) => l.line);
  assert.deepEqual(named("K0-2"), [16], "**K0-2/K0-3** names K0-2");
  assert.deepEqual(named("K0-3"), [16, 18], "and K0-3, as does **K0-3 merged**");
  assert.equal(
    handoff.leads[3].text,
    "- **K0-3 merged** (3c4d5e6, + a fix): verifier PASS WITH NOTES.",
  );
  assert.deepEqual(handoff.leads[2].commits, [], "(local config) names no commit");
});

test("frontmatter board: ids from a key or the file name, fields from keys", () => {
  const m = model("frontmatter-board");
  assert.deepEqual(m.problems, []);
  const e1 = item(m, "epic", "E1");
  assert.equal(e1.file, "epics/first-steps.md");
  assert.equal(e1.line, 2, "the id key's line");
  assert.deepEqual(e1.fields, { title: "First steps", status: "open", stories: ["S-1", "S-2"] });
  assert.equal(e1.phase, "active");
  const s1 = item(m, "story", "S-1");
  assert.deepEqual(s1.fields, {
    epic: "E1",
    status: "done",
    deps: null,
    shipped: "2026-03-01",
    commits: ["5e6f7a8", "6f7a8b9"],
  });
  assert.equal(s1.parent, "E1");
  assert.deepEqual(item(m, "story", "S-2").fields.deps, ["S-1"]);
  assert.deepEqual(item(m, "epic", "E2").children, []);
});

test("broken: a missing heading, column, file or id is a problem, not a throw", () => {
  const root = join(FIXTURES, "broken");
  const { spec, problems: specProblems } = loadSpec(join(root, "process.json"));
  assert.ok(specProblems.length > 0, "the spec itself is flagged");
  const m = readProcess({ root, spec });
  const found = m.problems.map((p) => `${p.rule} ${p.kind} ${p.message}`);
  assert.deepEqual(found, [
    'read sprint BOARD.md: no heading "Sprints"',
    'read task BOARD.md: the "Tasks" table has no column "Owner"',
    "read task BOARD.md: a task without an id",
    "read note NOTES.md: file not found",
    "read decision ../../outside/DECISIONS.md: outside the repository; not read",
  ]);
  assert.equal(m.kinds.sprint.located, false);
  assert.equal(m.kinds.task.located, true);
  assert.deepEqual(item(m, "task", "Z1").fields.owner, null, "a missing column reads as null");
  assert.equal(m.problems[1].line, 12);
});

test("a missing section heading in an item's own file is a problem", () => {
  const dropHandoff = (text) => text.replace("## Handoff", "## Notes");
  const root = copyWith("table-board", "docs/board/sprints/A1_the_loop.md", dropHandoff);
  const m = model("table-board", root);
  assert.deepEqual(
    m.problems.map((p) => [p.kind, p.id, p.message]),
    [["sprint", "A1", 'sprints/A1_the_loop.md: no heading "Handoff"']],
  );
  assert.equal(item(m, "sprint", "A1").own.sections.handoff, undefined);
});

test("loadSpec: a missing process file is a problem; readProcess takes a null spec", () => {
  const { spec, problems } = loadSpec(join(FIXTURES, "nowhere", "process.json"));
  assert.equal(spec, null);
  assert.equal(problems[0].rule, "spec");
  assert.match(problems[0].message, /cannot read the process file \(ENOENT\)/);
  const m = readProcess({ root: FIXTURES, spec });
  assert.deepEqual([m.kinds, m.index, m.problems], [{}, {}, []]);
});

test("ranks do not depend on the order the kinds are declared in", () => {
  const { spec } = loadSpec(join(FIXTURES, "table-board", "process.json"));
  spec.kinds.question.fields.blocks.role = "children"; // a kind holding a children list of tasks
  const ranks = (order) => {
    const kinds = Object.fromEntries(order.map((k) => [k, spec.kinds[k]]));
    const m = readProcess({ root: join(FIXTURES, "table-board"), spec: { ...spec, kinds } });
    return Object.fromEntries(
      Object.entries(m.kinds).map(([k, v]) => [k, v.items.map((i) => [i.id, i.rank])]),
    );
  };
  const names = Object.keys(spec.kinds);
  const last = ranks(names);
  assert.deepEqual(ranks(["question", ...names.filter((k) => k !== "question")]), last);
  assert.deepEqual(ranks(names.toReversed()), last);
  assert.equal(last.task.find(([id]) => id === "W3")[1], 2, "W3 keeps its sprint's rank");
});
