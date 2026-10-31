import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardReport, Finding, ProcessSpec } from "../src/process.js";

// Synthetic boards: invented ids and words, only the two shapes (table / one file per item).
const tableBoard = {
  version: 1,
  name: "Alpha",
  root: "docs/alpha",
  kinds: {
    sprint: {
      label: "Sprint",
      at: { table: "BOARD.md", heading: "Sprints" },
      id: { column: "Sprint" },
      fields: { status: { column: "Status" }, name: { column: "Name", type: "link" } },
      status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
      file: {
        glob: "sprints/{id}_*.md",
        required: true,
        except: ["X0"],
        sections: { handoff: { heading: "Handoff", as: "bold-lead" } },
      },
    },
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: {
        sprint: { column: "Sprint", type: "ref", ref: "sprint", role: "parent" },
        deps: { column: "Deps", type: "list", ref: ["task"] },
      },
      status: { derived: "children" },
      create: {
        ask: ["sprint"],
        id: "ask",
        rows: [{ in: "self", at: "after-last:sprint", cells: { Task: "{id}" } }],
      },
    },
  },
  rules: [
    { rule: "ids-unique" },
    { rule: "deps-done", label: "R4", kind: "task", field: "deps", except: { id: ["X0"] } },
  ],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", merged: "done" },
    write: { status: "status" },
  },
  drafts: { decision: { kind: "decision", map: { decision: "{answer}" } } },
  status: { now: "sprint", prime: true, lines: 12 },
};

const filesBoard = {
  version: 1,
  name: "Beta",
  root: ".",
  kinds: {
    epic: {
      label: "Epic",
      at: { files: "epics/*.md", id: "frontmatter:key" },
      fields: { state: { column: "state" } },
      status: { field: "state", values: { open: "active", shipped: "done" } },
    },
    note: { label: "Note", at: { files: "notes/*.md", id: "filename:{id}.md" } },
  },
  rules: [],
};

function issuePaths(input: unknown): string[] {
  const r = ProcessSpec.safeParse(input);
  assert.equal(r.success, false);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

test("ProcessSpec parses a table board and keeps rule params", () => {
  const spec = ProcessSpec.parse(tableBoard);
  assert.equal(spec.rules[1]?.field, "deps");
  assert.deepEqual(spec.rules[1]?.except, { id: ["X0"] });
});

test("ProcessSpec parses a frontmatter-files board", () => {
  const spec = ProcessSpec.parse(filesBoard);
  assert.deepEqual(Object.keys(spec.kinds), ["epic", "note"]);
});

test("an unknown `at` shape fails with the path to it", () => {
  const bad = { ...filesBoard, kinds: { epic: { label: "Epic", at: { folder: "epics" } } } };
  assert.ok(issuePaths(bad).some((p) => p.startsWith("kinds.epic.at")));
});

test("a files location with a bad id source fails at kinds.<kind>.at.id", () => {
  const bad = {
    ...filesBoard,
    kinds: { epic: { label: "Epic", at: { files: "e/*.md", id: "title" } } },
  };
  assert.ok(issuePaths(bad).includes("kinds.epic.at.id"));
});

test("an unknown phase fails with the path to the value", () => {
  const bad = structuredClone(tableBoard);
  bad.kinds.sprint.status.values.todo = "someday";
  assert.ok(issuePaths(bad).includes("kinds.sprint.status.values.todo"));
});

test("a rule without `rule` fails at rules.<n>.rule", () => {
  const bad = { ...tableBoard, rules: [{ rule: "ids-unique" }, { label: "R4", kind: "task" }] };
  assert.ok(issuePaths(bad).includes("rules.1.rule"));
});

test("an unsupported version is rejected", () => {
  assert.ok(issuePaths({ ...filesBoard, version: 2 }).includes("version"));
});

test("Finding needs a message; BoardReport carries findings and a default-filled status", () => {
  assert.throws(() => Finding.parse({ rule: "ids-unique" }));
  const report = BoardReport.parse({
    ok: false,
    name: "Alpha",
    root: "docs/alpha",
    rules: 2,
    items: { task: 3 },
    findings: [
      {
        rule: "deps-done",
        id: "T1",
        message: "doing, but dep T0 is todo",
        file: "BOARD.md",
        line: 9,
      },
    ],
    status: {},
  });
  assert.equal(report.findings[0]?.line, 9);
  assert.deepEqual(report.status?.blocked, []);
});
