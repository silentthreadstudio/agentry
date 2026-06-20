// doc-tree — the PURE navigator transform (task 008). Asserts the OBSERVABLE grouping/ordering the Docs
// navigator renders from a run's GraphModel: Definition (Spec→Plan) · Decisions (ADRs) · Tasks (status
// dots), derived from node ids. Behavior, not internals — the tree a caller sees, not how it's built.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphModel } from "@agentry/workbench-shared";
import { buildDocTree, kindGlyphOf } from "../routes/work/docs/doc-tree.js";

// A representative run graph: routing root + the synthetic adr-group are NON-documents (must be excluded);
// spec/plan/adr-*/task-* are the docs. Node order is deliberately NOT spec-then-plan, to prove the sort.
function sampleGraph(): GraphModel {
  return {
    nodes: [
      { id: "routing", label: "routing: decompose+verify", status: "done" },
      { id: "plan", label: "plan", status: "done" },
      { id: "spec", label: "spec", status: "done" },
      { id: "adr-001", label: "adr 001: ports-and-adapters", status: "done" },
      { id: "adr-003", label: "adr 003: two-artifact dist", status: "done" },
      { id: "task-014", label: "014 markdown-serializer", status: "in-progress" },
      { id: "task-026", label: "026 live verification", status: "todo" },
    ],
    edges: [],
  };
}

test("groups docs into Definition / Decisions / Tasks by node id", () => {
  const groups = buildDocTree(sampleGraph());
  assert.deepEqual(
    groups.map((g) => g.key),
    ["definition", "decisions", "tasks"],
  );
});

test("excludes the routing root and any non-document node", () => {
  const ids = buildDocTree(sampleGraph()).flatMap((g) => g.items.map((i) => i.id));
  assert.ok(!ids.includes("routing"), "the routing root is not a document");
  assert.deepEqual(ids, ["spec", "plan", "adr-001", "adr-003", "task-014", "task-026"]);
});

test("orders Definition Spec-before-Plan regardless of graph node order", () => {
  const def = buildDocTree(sampleGraph()).find((g) => g.key === "definition");
  assert.deepEqual(def?.items.map((i) => i.id), ["spec", "plan"]);
});

test("headings carry the Decisions / Tasks counts", () => {
  const groups = buildDocTree(sampleGraph());
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g.heading]));
  assert.equal(byKey.definition, "Definition");
  assert.equal(byKey.decisions, "Decisions · 2");
  assert.equal(byKey.tasks, "Tasks · 2");
});

test("a task row carries its FLOW status (the navigator status dot)", () => {
  const tasks = buildDocTree(sampleGraph()).find((g) => g.key === "tasks");
  const byId = Object.fromEntries((tasks?.items ?? []).map((i) => [i.id, i.status]));
  assert.equal(byId["task-014"], "in-progress");
  assert.equal(byId["task-026"], "todo");
});

test("a row label reads as '<key> · <title>' for adr/task, the kind for spec/plan", () => {
  const items = buildDocTree(sampleGraph()).flatMap((g) => g.items);
  const byId = Object.fromEntries(items.map((i) => [i.id, i.label]));
  assert.equal(byId["spec"], "Spec");
  assert.equal(byId["plan"], "Plan");
  assert.equal(byId["adr-001"], "001 · ports-and-adapters");
  assert.equal(byId["task-014"], "014 · markdown-serializer");
});

test("drops a group with no members (a run with no ADRs shows no Decisions section)", () => {
  const noAdrs: GraphModel = {
    nodes: [
      { id: "spec", label: "spec", status: "done" },
      { id: "task-001", label: "001 first", status: "todo" },
    ],
    edges: [],
  };
  const keys = buildDocTree(noAdrs).map((g) => g.key);
  assert.deepEqual(keys, ["definition", "tasks"]);
});

test("an empty graph yields no groups", () => {
  assert.deepEqual(buildDocTree({ nodes: [], edges: [] }), []);
});

test("kindGlyphOf maps each doc kind to its mockup glyph", () => {
  assert.equal(kindGlyphOf("spec"), "§");
  assert.equal(kindGlyphOf("plan"), "▦");
  assert.equal(kindGlyphOf("adr-001"), "◇");
  assert.equal(kindGlyphOf("task-014"), "▤");
});
