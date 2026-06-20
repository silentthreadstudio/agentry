// Tests for the ADR "Decisions" group transform + the node-kind gate (task 005/006). These are the two
// pure, load-bearing pieces behind the group card and BUG 4a (the click gate):
//   • applyAdrGroup — ALWAYS collapses adr-* nodes into ONE synthetic group node (task 006 removed the
//     canvas-expand passthrough; the ADRs are listed in the Decisions drawer instead, not on the graph).
//     The server GraphModel is never mutated.
//   • layoutGraph's per-node `kind` — the discriminator Panorama's onNodeClick reads to decide whether a
//     node opens a doc (kind "doc") or is inert/opens the Decisions drawer (kind "routing"/"group"). If
//     this is wrong, the click gate 404s on a non-doc node — so we assert the kind directly. The group
//     node also carries the rolled-up ADR list (`data.adrs`) the drawer renders without re-fetching.
import assert from "node:assert/strict";
import test from "node:test";
import type { GraphModel } from "@agentry/workbench-shared";
import { ADR_GROUP_ID, applyAdrGroup, layoutGraph } from "../routes/work/live/layout-dagre.js";

// A small run graph: routing → spec → plan → {adr-001, adr-003, task-001}, with plan→adr derives edges.
function sampleGraph(): GraphModel {
  return {
    nodes: [
      { id: "routing", label: "routing: decompose+verify", status: "done" },
      { id: "spec", label: "spec", status: "done" },
      { id: "plan", label: "plan", status: "done" },
      { id: "adr-001", label: "adr 001: ports-and-adapters", status: "done" },
      { id: "adr-003", label: "adr 003: dist-lockstep", status: "done" },
      { id: "task-001", label: "001 the first task", status: "in-progress" },
    ],
    edges: [
      { from: "routing", to: "spec", kind: "derives" },
      { from: "spec", to: "plan", kind: "derives" },
      { from: "plan", to: "adr-001", kind: "derives" },
      { from: "plan", to: "adr-003", kind: "derives" },
      { from: "plan", to: "task-001", kind: "derives" },
    ],
  };
}

test("applyAdrGroup collapses every adr-* node into one group node", () => {
  const out = applyAdrGroup(sampleGraph());
  const ids = out.nodes.map((n) => n.id);
  assert.ok(!ids.includes("adr-001"), "individual ADR dropped");
  assert.ok(!ids.includes("adr-003"), "individual ADR dropped");
  assert.equal(ids.filter((id) => id === ADR_GROUP_ID).length, 1, "exactly one group node added");
});

test("applyAdrGroup collapses the N plan->adr derives edges into ONE plan->group edge (deduped)", () => {
  const out = applyAdrGroup(sampleGraph());
  const planToGroup = out.edges.filter((e) => e.from === "plan" && e.to === ADR_GROUP_ID);
  assert.equal(planToGroup.length, 1, "two plan->adr edges collapse to one plan->group edge");
  // the non-adr edges are untouched
  assert.ok(out.edges.some((e) => e.from === "plan" && e.to === "task-001"), "task edge preserved");
  assert.ok(out.edges.some((e) => e.from === "routing" && e.to === "spec"), "spine edge preserved");
});

test("applyAdrGroup never mutates the input model (pure)", () => {
  const model = sampleGraph();
  const before = JSON.stringify(model);
  applyAdrGroup(model);
  assert.equal(JSON.stringify(model), before, "the server GraphModel is not mutated");
});

test("applyAdrGroup leaves a graph with no ADRs untouched (no empty group)", () => {
  const noAdr: GraphModel = {
    nodes: [{ id: "spec", label: "spec", status: "done" }],
    edges: [],
  };
  const out = applyAdrGroup(noAdr);
  assert.ok(!out.nodes.some((n) => n.id === ADR_GROUP_ID), "no group when there are no ADRs");
});

test("layoutGraph stamps kind=routing on the root, kind=group on the collapsed ADR container (BUG 4a gate)", () => {
  const { nodes } = layoutGraph("run-1", sampleGraph(), new Set());
  const routing = nodes.find((n) => n.id === "routing");
  const group = nodes.find((n) => n.id === ADR_GROUP_ID);
  assert.equal(routing?.data.kind, "routing", "routing root is non-document → click is gated out");
  assert.equal(group?.data.kind, "group", "ADR group container is non-document → click opens the drawer");
  assert.equal(group?.data.adrCount, 2, "the group rolls up both ADRs in its count chip");
});

test("layoutGraph stamps the group's ADR list (id + label) for the Decisions drawer to render", () => {
  const { nodes } = layoutGraph("run-1", sampleGraph(), new Set());
  const group = nodes.find((n) => n.id === ADR_GROUP_ID);
  assert.deepEqual(
    group?.data.adrs,
    [
      { id: "adr-001", label: "adr 001: ports-and-adapters" },
      { id: "adr-003", label: "adr 003: dist-lockstep" },
    ],
    "the group carries each ADR's id + label so the drawer needs no re-fetch",
  );
});

test("layoutGraph stamps kind=doc on spec/plan/task (they open docs)", () => {
  const nodes = layoutGraph("run-1", sampleGraph(), new Set()).nodes;
  assert.equal(nodes.find((n) => n.id === "spec")?.data.kind, "doc");
  assert.equal(nodes.find((n) => n.id === "task-001")?.data.kind, "doc");
  // the real ADR nodes are collapsed away — only the group remains, never a bare adr-* node
  assert.ok(!nodes.some((n) => n.id === "adr-001"), "the individual ADR is collapsed into the group");
});

test("layoutGraph produces no overlapping positions (collapsed group)", () => {
  const { nodes } = layoutGraph("run-1", sampleGraph(), new Set());
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const samePoint = a.position.x === b.position.x && a.position.y === b.position.y;
      assert.ok(!samePoint, `nodes ${a.id} and ${b.id} must not share a position`);
    }
  }
});
