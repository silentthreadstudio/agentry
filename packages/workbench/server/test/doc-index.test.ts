// buildDocIndex proof — the pure domain core. Asserts on the observable list: which artifacts become
// documents, their ids, their labels, their status, and the READING ORDER.
//
// The fixture is a trimmed copy of a real run's shape (a spec/plan, an adr, and tasks whose frontmatter
// carries `status` as FLOW writes it), so the test exercises actual on-disk frontmatter rather than an
// invented one. No fs, no ws — buildDocIndex is pure, so it is plain data in, list out.
//
// This replaced `graph.test.ts`, which additionally proved four kinds of typed edge. Those edges were
// derived on every read and consumed by nothing once the canvas was deleted, so both they and their
// test went with it: a proof of a model nobody reads only makes the model harder to remove.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDocIndex } from "../src/domain/doc-index.js";
import type { RunFiles } from "../src/domain/ports.js";

function fixture(over: Partial<RunFiles> = {}): RunFiles {
  return {
    run: "build-agentry-workbench",
    routing: { shape: "decompose+verify", kind: "feature" },
    spec: { frontmatter: { kind: "spec" }, body: "# Spec" },
    plan: { frontmatter: { id: "plan", title: "the plan" }, body: "# Plan" },
    adrs: [{ frontmatter: { id: "ADR-001", title: "stateless over files" }, body: "# ADR-001" }],
    tasks: [
      { taskNo: "001", frontmatter: { title: "shared types", status: "done" }, body: "" },
      { taskNo: "003", frontmatter: { title: "flow exports", status: "in-progress" }, body: "" },
      { taskNo: "006", frontmatter: { title: "server domain" }, body: "" },
    ],
    ...over,
  };
}

test("one entry per artifact, in reading order: spec → plan → adrs → tasks", () => {
  const docs = buildDocIndex(fixture());
  assert.deepEqual(
    docs.map((d) => d.id),
    ["spec", "plan", "adr-ADR-001", "task-001", "task-003", "task-006"],
  );
});

test("the routing decision is NOT a document — it has no file to open", () => {
  assert.ok(!buildDocIndex(fixture()).some((d) => d.id === "routing"));
});

test("a task carries its FLOW status; a task with none reads as todo, not as missing", () => {
  const byId = new Map(buildDocIndex(fixture()).map((d) => [d.id, d]));
  assert.equal(byId.get("task-001")?.status, "done");
  assert.equal(byId.get("task-003")?.status, "in-progress");
  assert.equal(byId.get("task-006")?.status, "todo");
});

test("a malformed status falls back to todo rather than throwing", () => {
  const docs = buildDocIndex(
    fixture({
      spec: null,
      plan: null,
      adrs: [],
      tasks: [{ taskNo: "001", frontmatter: { title: "t", status: "banana" }, body: "" }],
    }),
  );
  assert.equal(docs[0]?.status, "todo");
});

test("spec and plan read as settled — they have no lifecycle of their own", () => {
  const byId = new Map(buildDocIndex(fixture()).map((d) => [d.id, d]));
  assert.equal(byId.get("spec")?.status, "done");
  assert.equal(byId.get("plan")?.status, "done");
});

test("labels are what the tab strip shows: the adr key + title, the task number + title", () => {
  const byId = new Map(buildDocIndex(fixture()).map((d) => [d.id, d]));
  assert.equal(byId.get("adr-ADR-001")?.label, "adr ADR-001: stateless over files");
  assert.equal(byId.get("task-001")?.label, "001 shared types");
});

test("an adr with no frontmatter id falls back to its index, so two adrs never collide", () => {
  const docs = buildDocIndex(
    fixture({
      adrs: [
        { frontmatter: {}, body: "" },
        { frontmatter: {}, body: "" },
      ],
    }),
  );
  const ids = docs.filter((d) => d.id.startsWith("adr-")).map((d) => d.id);
  assert.deepEqual(ids, ["adr-0", "adr-1"]);
});

test("a run with nothing written yet is an empty index, not a crash", () => {
  assert.deepEqual(buildDocIndex(fixture({ spec: null, plan: null, adrs: [], tasks: [] })), []);
});
