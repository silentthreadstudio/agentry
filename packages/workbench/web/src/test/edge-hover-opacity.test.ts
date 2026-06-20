// Regression for task 007 (node flicker on hover/pan). The flicker came from rebuilding the whole
// nodes/edges arrays on every hover; the fix moves the lit/dim opacity off the arrays and into the
// HoverContext, read at render time by TypedEdge via `edgeHoverOpacity`. This pins that rule to the SAME
// values the old per-hover Panorama logic produced, so decoupling hover from the array rebuild did not
// change the observable hover-highlight: lit when BOTH endpoints are in the lit set, dim otherwise, and a
// slightly-muted resting opacity when nothing is hovered.
//
// (The old rule, for the record:  lit = !litSet || (litSet.has(src) && litSet.has(tgt));
//                                 opacity = lit ? (litSet ? 1 : 0.85) : 0.18; )
import assert from "node:assert/strict";
import test from "node:test";
import { edgeHoverOpacity } from "../routes/work/live/edge-types.js";

test("resting (nothing hovered) edges sit at the muted 0.85", () => {
  assert.equal(edgeHoverOpacity(null, "a", "b"), 0.85);
});

test("an edge with BOTH endpoints in the lit set is fully lit (1)", () => {
  const lit = new Set(["a", "b"]);
  assert.equal(edgeHoverOpacity(lit, "a", "b"), 1);
});

test("an edge with only one endpoint lit is dimmed (0.18)", () => {
  const lit = new Set(["a"]);
  assert.equal(edgeHoverOpacity(lit, "a", "b"), 0.18);
});

test("an edge with neither endpoint lit is dimmed (0.18)", () => {
  const lit = new Set(["x", "y"]);
  assert.equal(edgeHoverOpacity(lit, "a", "b"), 0.18);
});

test("an empty lit set (hover with no neighbors matched) dims every edge", () => {
  // hovering a node still produces a non-null litSet (at least {hoveredId}); an edge not touching it dims.
  assert.equal(edgeHoverOpacity(new Set<string>(), "a", "b"), 0.18);
});
