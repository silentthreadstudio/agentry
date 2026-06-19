// buildGraph proof — the pure domain core (task 006). Asserts on the observable `GraphModel`: the
// node kinds (routing/spec/adr/plan/task) and ALL FOUR typed edges (derives|depends-on|blocks|
// satisfies) derived from frontmatter. The fixture is a trimmed copy of THIS run's real shape (a
// `decompose+verify` routing decision, a spec/plan, an adr, and tasks whose frontmatter carries
// `deps` as numbers + a `satisfies` field) so the test exercises the actual on-disk frontmatter,
// not an invented one. No fs, no ws — buildGraph is pure, so the test is plain data in, model out.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunFiles } from "../src/domain/ports.js";
import { buildGraph } from "../src/domain/graph.js";

// A trimmed fixture mirroring `.agentry/work/<this-run>/`: routing → spec → plan → {adr, tasks}.
// task 003 is `done` (so it depends-on but does NOT block); task 006 depends on 1 and 3, and is
// in-progress; task 001 declares `satisfies` (the AC it closes). deps are numbers, as FLOW writes them.
function fixture(): RunFiles {
  return {
    run: "build-agentry-workbench",
    routing: { shape: "decompose+verify", kind: "feature" },
    spec: { frontmatter: { kind: "spec" }, body: "# Spec" },
    plan: { frontmatter: { id: "plan", title: "the plan" }, body: "# Plan" },
    adrs: [{ frontmatter: { id: "ADR-001", title: "stateless over files" }, body: "# ADR-001" }],
    tasks: [
      { taskNo: "001", frontmatter: { title: "shared types", status: "done", deps: [], satisfies: ["AC5"] }, body: "" },
      { taskNo: "003", frontmatter: { title: "flow exports", status: "done", deps: [] }, body: "" },
      { taskNo: "006", frontmatter: { title: "server domain", status: "in-progress", deps: [1, 3] }, body: "" },
    ],
  };
}

// Edge-membership helper — asserts on the observable edge set, order-independent.
function hasEdge(edges: { from: string; to: string; kind: string }[], from: string, to: string, kind: string): boolean {
  return edges.some((e) => e.from === from && e.to === to && e.kind === kind);
}

test("builds a node for each artifact kind with the right status", () => {
  const { nodes } = buildGraph(fixture());
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Every kind is present: routing root, spec, plan, adr, and one node per task.
  assert.ok(byId.has("routing"), "routing root node");
  assert.ok(byId.has("spec"), "spec node");
  assert.ok(byId.has("plan"), "plan node");
  assert.ok(byId.has("adr-ADR-001"), "adr node keyed by frontmatter id");
  assert.ok(byId.has("task-001") && byId.has("task-003") && byId.has("task-006"), "a node per task");

  // Task status is FLOW's closed status, carried through from frontmatter.
  assert.equal(byId.get("task-006")?.status, "in-progress");
  assert.equal(byId.get("task-003")?.status, "done");
});

test("derives edges follow the routing→spec→plan→{adr,task} chain", () => {
  const { edges } = buildGraph(fixture());
  assert.ok(hasEdge(edges, "routing", "spec", "derives"), "routing derives spec");
  assert.ok(hasEdge(edges, "spec", "plan", "derives"), "spec derives plan");
  assert.ok(hasEdge(edges, "plan", "adr-ADR-001", "derives"), "plan derives adr");
  assert.ok(hasEdge(edges, "plan", "task-006", "derives"), "plan derives task");
});

test("depends-on edges come from a task's deps frontmatter", () => {
  const { edges } = buildGraph(fixture());
  assert.ok(hasEdge(edges, "task-006", "task-001", "depends-on"), "006 depends on 001");
  assert.ok(hasEdge(edges, "task-006", "task-003", "depends-on"), "006 depends on 003");
});

test("blocks edges are the active inverse — only an UNFINISHED upstream blocks", () => {
  const { edges } = buildGraph(fixture());
  // 001 and 003 are both `done`, so neither actively blocks 006 → no blocks edges in this fixture.
  assert.equal(edges.filter((e) => e.kind === "blocks").length, 0, "done upstreams do not block");

  // Flip 003 to in-progress: now it actively gates 006.
  const f = fixture();
  f.tasks[1]!.frontmatter.status = "in-progress";
  const { edges: e2 } = buildGraph(f);
  assert.ok(hasEdge(e2, "task-003", "task-006", "blocks"), "unfinished 003 blocks 006");
  assert.ok(!hasEdge(e2, "task-001", "task-006", "blocks"), "still-done 001 does not block");
});

test("satisfies edges link a task's satisfies frontmatter to the spec", () => {
  const { edges } = buildGraph(fixture());
  assert.ok(hasEdge(edges, "task-001", "spec", "satisfies"), "001 satisfies an AC (→ spec)");
  // 006 declares no `satisfies` → no satisfies edge from it.
  assert.ok(!hasEdge(edges, "task-006", "spec", "satisfies"), "006 has no satisfies edge");
});

test("all four edge kinds are present on a realistic run", () => {
  const { edges } = buildGraph(fixture());
  const kinds = new Set(edges.map((e) => e.kind));
  // depends-on, derives, satisfies present here; blocks only when an upstream is unfinished.
  const f = fixture();
  f.tasks[2]!.frontmatter.deps = [1, 3];
  f.tasks[1]!.frontmatter.status = "in-progress"; // make 003 actively block 006
  const all = new Set(buildGraph(f).edges.map((e) => e.kind));
  for (const k of ["derives", "depends-on", "blocks", "satisfies"]) {
    assert.ok(all.has(k), `edge kind ${k} present`);
  }
  // sanity: the always-present three hold without the flip too.
  for (const k of ["derives", "depends-on", "satisfies"]) assert.ok(kinds.has(k), `${k} present`);
});

test("a dep on a task absent from the run yields no dangling edge", () => {
  const f = fixture();
  f.tasks[2]!.frontmatter.deps = [1, 99]; // 99 is not in the run
  const { edges } = buildGraph(f);
  assert.ok(hasEdge(edges, "task-006", "task-001", "depends-on"), "real dep kept");
  assert.ok(!edges.some((e) => e.to === "task-099"), "dep on absent task dropped (99 → 099, not in run)");
});

test("an empty run produces an empty graph (no nodes, no edges)", () => {
  const empty: RunFiles = { run: "empty", routing: null, spec: null, plan: null, adrs: [], tasks: [] };
  const { nodes, edges } = buildGraph(empty);
  assert.equal(nodes.length, 0);
  assert.equal(edges.length, 0);
});
