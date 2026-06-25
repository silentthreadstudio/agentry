// BROKEN overlay — the obvious build: it toposorts and runs, but never checks for a cycle first. On an acyclic
// graph it works, so the bug hides; on a CYCLIC graph the (partial) toposort silently drops the cyclic tasks and
// run() returns incomplete results instead of rejecting. seed+broken FAILS the oracle's cycle-rejection probe.
const { createGraph } = require("./graph.js");
const { toposort } = require("./toposort.js");
const { runOrder } = require("./runner.js");

function createScheduler() {
  const graph = createGraph();
  const tasks = {};
  return {
    add(id, deps, fn) {
      graph.addTask(id, deps || []);
      tasks[id] = fn;
    },
    run() {
      // BUG: no cycle detection — a cyclic graph is not rejected. toposort drops the cyclic nodes,
      // so run() silently returns partial results instead of throwing a "cycle" error.
      const order = toposort(graph);
      const results = runOrder(order, tasks, (id) => graph.depsOf(id));
      return { results };
    },
  };
}

module.exports = { createScheduler };
