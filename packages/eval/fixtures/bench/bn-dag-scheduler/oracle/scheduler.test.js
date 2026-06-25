// HIDDEN held-out oracle — two discriminators across the toposort+cycle+runner seam:
// (a) a CYCLIC graph must be REJECTED before running (the broken build, lacking cycle detection, returns partial
//     results instead of throwing); (b) independent tasks must run in a DETERMINISTIC, insertion-ordered sequence.
const test = require("node:test");
const assert = require("node:assert/strict");

const { createScheduler } = require("../src/index.js");
const { toposort } = require("../src/toposort.js");
const { findCycle } = require("../src/cycle.js");
const { createGraph } = require("../src/graph.js");

test("runs a simple chain and passes each task its dependencies' results", () => {
  const s = createScheduler();
  s.add("a", [], () => 1);
  s.add("b", ["a"], (deps) => deps.a + 1);
  s.add("c", ["b"], (deps) => deps.b + 1);
  const { results } = s.run();
  assert.equal(results.a, 1);
  assert.equal(results.b, 2);
  assert.equal(results.c, 3);
});

test("a dependency always runs before its dependent regardless of add order", () => {
  const s = createScheduler();
  // dependent added BEFORE its dependency — a correct toposort still runs the dep first
  s.add("b", ["a"], (deps) => "b:" + deps.a);
  s.add("a", [], () => "a");
  const { results } = s.run();
  assert.equal(results.a, "a");
  assert.equal(results.b, "b:a");
});

test("CYCLE PROBE: a cyclic graph is rejected (throws a 'cycle' error), not run partially", () => {
  const s = createScheduler();
  s.add("a", ["c"], () => 1);
  s.add("b", ["a"], () => 2);
  s.add("c", ["b"], () => 3); // a -> c -> b -> a forms a cycle
  assert.throws(
    () => s.run(),
    (err) => err instanceof Error && /cycle/i.test(err.message),
    "a cyclic graph must throw an Error mentioning 'cycle', not return partial results",
  );
});

test("CYCLE PROBE: a self-loop is rejected", () => {
  const s = createScheduler();
  s.add("a", ["a"], () => 1);
  assert.throws(() => s.run(), /cycle/i);
});

test("DETERMINISM PROBE: independent tasks run in a stable insertion order across runs", () => {
  // Five mutually-independent roots feeding one sink. The order roots run in must be the insertion order
  // (x1..x5) every time — never object-key order, Set order, or anything input-shape dependent.
  function build() {
    const s = createScheduler();
    const seen = [];
    for (const id of ["x1", "x2", "x3", "x4", "x5"]) {
      s.add(id, [], () => {
        seen.push(id);
        return id;
      });
    }
    s.add("sink", ["x1", "x2", "x3", "x4", "x5"], () => "done");
    s.run();
    return seen;
  }
  const first = build();
  assert.deepEqual(first, ["x1", "x2", "x3", "x4", "x5"], "independent tasks run in insertion order");
  // Reproducible: a second identical build yields the identical order.
  assert.deepEqual(build(), first, "the run order is deterministic across runs");
});

test("DETERMINISM PROBE: toposort tie-break follows graph insertion order", () => {
  const g = createGraph();
  g.addTask("c", []);
  g.addTask("a", []);
  g.addTask("b", []); // three independent nodes — ties broken by insertion order: c, a, b
  assert.deepEqual(toposort(g), ["c", "a", "b"]);
});

test("findCycle returns null on an acyclic graph and the cycle path on a cyclic one", () => {
  const acyclic = createGraph();
  acyclic.addTask("a", []);
  acyclic.addTask("b", ["a"]);
  assert.equal(findCycle(acyclic), null);

  const cyclic = createGraph();
  cyclic.addTask("a", ["b"]);
  cyclic.addTask("b", ["a"]);
  const cycle = findCycle(cyclic);
  assert.ok(Array.isArray(cycle) && cycle.length >= 2, "a cycle path is returned");
  assert.ok(cycle.includes("a") && cycle.includes("b"));
});
