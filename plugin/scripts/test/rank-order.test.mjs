// Property test: what the reader derives (ranks, parents, children, phases), what `check` finds and
// what `status` shows never depend on the order the kinds are declared in (owner decision A27).
// Synthetic boards: milestone > sprint (the ordered kind) > epic (parent sprint, children tasks) > task,
// a task with two parents, an epic with a late sprint among its children, and two cycles (kinds that list each other as children), one reached from an epic and one reached from nothing.
// Run: node --test plugin/scripts/test/rank-order.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { check } from "../lib/process/check.mjs";
import { loadSpec, readProcess } from "../lib/process/read.mjs";
import { statusView, workKind } from "../lib/process/status.mjs";
import { writeSpec } from "./spec-files.mjs";

const table = (heading, header, rows) => [
  `## ${heading}`,
  "",
  `| ${header.join(" | ")} |`,
  `|${header.map(() => " --- |").join("")}`,
  ...rows.map((r) => `| ${r.join(" | ")} |`),
  "",
];
const STATUS = { todo: "planned", doing: "active", done: "done" };
const kindOf = (heading, id, fields, status) => ({
  label: heading,
  at: { table: "BOARD.md", heading },
  id: { column: id },
  fields,
  status,
});
const own = { field: "status", values: STATUS };
const KINDS = {
  milestone: kindOf(
    "Milestones",
    "Milestone",
    { sprints: { column: "Sprints", type: "list", ref: "sprint", role: "children" } },
    { derived: "children" },
  ),
  sprint: kindOf("Sprints", "Sprint", { status: { column: "Status" } }, own),
  epic: kindOf(
    "Epics",
    "Epic",
    {
      sprint: { column: "Sprint", type: "ref", ref: "sprint", role: "parent" },
      tasks: { column: "Tasks", type: "list", ref: ["task", "ping", "sprint"], role: "children" },
    },
    { derived: "children" },
  ),
  task: kindOf(
    "Tasks",
    "Task",
    {
      sprint: { column: "Sprint", type: "ref", ref: "sprint", role: "parent" },
      status: { column: "Status" },
      deps: { column: "Deps", type: "list", ref: "task" },
    },
    own,
  ),
  ping: kindOf(
    "Pings",
    "Ping",
    {
      kids: { column: "Kids", type: "list", ref: "pong", role: "children" },
      status: { column: "Status" },
    },
    own,
  ),
  pong: kindOf(
    "Pongs",
    "Pong",
    { kids: { column: "Kids", type: "list", ref: "ping", role: "children" } },
    { derived: "children" },
  ),
};
const SPEC = {
  version: 1,
  name: "Rank order",
  root: ".",
  kinds: KINDS,
  rules: [
    { rule: "deps-not-forward", kind: "task", field: "deps" },
    { rule: "deps-done", kind: "task", field: "deps" },
    { rule: "parent-active", kind: "task" },
  ],
  lifecycle: { kind: "task", on: { built: "doing" } },
  status: { now: "sprint" },
};

// Two boards: the second lists the sprints the other way round, so the same epics rank differently.
const BOARDS = {
  forward: {
    sprints: ["S1", "S2", "S3"],
    epics: [
      ["E1", "S3", "T1, G1"],
      ["E2", "S1", "T2, S3"],
    ],
  },
  reversed: {
    sprints: ["S3", "S2", "S1"],
    epics: [
      ["E1", "S1", "T1, G1"],
      ["E2", "S3", "T2, S1"],
    ],
  },
};
function boardText({ sprints, epics }) {
  return [
    ...table(
      "Milestones",
      ["Milestone", "Sprints"],
      [
        ["M1", `${sprints[0]}, ${sprints[1]}`],
        ["M2", sprints[2]],
      ],
    ),
    ...table(
      "Sprints",
      ["Sprint", "Status"],
      sprints.map((s, i) => [s, i === 0 ? "doing" : "todo"]),
    ),
    ...table("Epics", ["Epic", "Sprint", "Tasks"], epics),
    ...table(
      "Tasks",
      ["Task", "Sprint", "Status", "Deps"],
      [
        ["T1", "S1", "doing", ""],
        ["T2", "S2", "todo", ""],
        ["T3", "S3", "todo", "T1, T2"],
        ["T4", "S1", "todo", "T3"],
        ["T5", "S2", "todo", "T6"],
        ["T6", "S3", "todo", ""],
        ["T7", "S2", "todo", "T2"],
      ],
    ),
    ...table(
      "Pings",
      ["Ping", "Kids", "Status"],
      [
        ["G1", "H1", "todo"],
        ["G2", "H2", "doing"],
      ],
    ),
    ...table(
      "Pongs",
      ["Pong", "Kids"],
      [
        ["H1", "G1"],
        ["H2", "G2"],
      ],
    ),
  ].join("\n");
}

const permutations = (xs) =>
  xs.length < 2
    ? [xs]
    : xs.flatMap((x, i) =>
        permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
      );
// 720 orders of six kinds, thinned to about 120 (every sixth, plus the reverse of the declared one).
const NAMES = Object.keys(KINDS);
const ORDERS = [...permutations(NAMES).filter((_, i) => i % 6 === 0), NAMES.toReversed()];

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function load(board) {
  const root = mkdtempSync(join(tmpdir(), "agentry-rank-"));
  dirs.push(root);
  writeFileSync(join(root, "BOARD.md"), boardText(board));
  const { spec, problems } = loadSpec(writeSpec(root, SPEC));
  assert.deepEqual(problems, [], "the synthetic spec is valid");
  return { root, spec };
}

/** Everything the reader, `check` and `status` say, as one value that ignores kind order. */
function observe({ root, spec }, order) {
  const reordered = { ...spec, kinds: Object.fromEntries(order.map((k) => [k, spec.kinds[k]])) };
  const model = readProcess({ root, spec: reordered });
  const items = Object.fromEntries(
    Object.entries(model.kinds)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [
        k,
        v.items.map((i) => [i.id, i.rank, i.parent, i.phase, i.children.join(",")]),
      ]),
  );
  const findings = check(model, reordered.rules, { hasCommit: () => false })
    .map((f) => JSON.stringify(f))
    .sort();
  return {
    items,
    findings,
    problems: model.problems,
    status: JSON.parse(JSON.stringify(statusView({ root, spec: reordered, model }))),
  };
}
const rankOf = (seen, kind, id) => seen.items[kind].find(([x]) => x === id)[1];

for (const [name, board] of Object.entries(BOARDS))
  test(`${name} board: ranks, findings and status are the same under ${ORDERS.length} kind orders`, () => {
    const loaded = load(board);
    const base = observe(loaded, NAMES);
    for (const order of ORDERS)
      assert.deepEqual(observe(loaded, order), base, `kinds declared as ${order.join(",")}`);
  });

for (const [name, board] of Object.entries(BOARDS))
  test(`${name} board without lifecycle.kind: status is the same under ${ORDERS.length} kind orders`, () => {
    const loaded = load(board);
    const { lifecycle, ...rest } = loaded.spec;
    const bare = { ...loaded, spec: rest };
    const base = observe(bare, NAMES);
    assert.equal(workKind(rest), "task", "the leaf of the parent tree is the work kind");
    for (const order of ORDERS)
      assert.deepEqual(observe(bare, order), base, `kinds declared as ${order.join(",")}`);
  });

test("a rank is the lowest of an item's parents', else the highest of its children's", () => {
  const seen = observe(load(BOARDS.forward), NAMES);
  const r = (kind, id) => rankOf(seen, kind, id);
  assert.deepEqual([r("sprint", "S1"), r("sprint", "S2"), r("sprint", "S3")], [0, 1, 2]);
  assert.equal(r("epic", "E1"), 2, "an epic takes its sprint's rank");
  assert.equal(
    r("epic", "E2"),
    0,
    "its own sprint's, though a child ranks 2: parents before children",
  );
  assert.equal(r("task", "T1"), 0, "sprint S1 (0) and epic E1 (2): the lowest");
  assert.equal(r("task", "T2"), 0, "sprint S2 (1) and epic E2 (0): the lowest");
  assert.equal(r("task", "T3"), 2, "one parent");
  assert.equal(r("milestone", "M1"), 1, "no parent: its last sprint's");
  assert.equal(r("ping", "G1"), 2, "a cycle with an anchor shares the anchor's rank");
  assert.equal(r("pong", "H1"), 2);
  assert.equal(r("ping", "G2"), undefined, "a cycle nothing ranks has none");
  assert.equal(r("pong", "H2"), undefined);
});

test("deps-not-forward finds the same two forward dependencies whatever order the epic is declared in", () => {
  const seen = observe(load(BOARDS.forward), NAMES);
  const forward = seen.findings
    .map((f) => JSON.parse(f))
    .filter((f) => f.rule === "deps-not-forward");
  assert.deepEqual(forward.map((f) => f.id).sort(), ["T4", "T5"]);
});
