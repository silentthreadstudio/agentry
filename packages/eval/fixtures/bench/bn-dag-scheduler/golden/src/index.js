// GOLDEN overlay — the scheduler: compose graph + cycle + toposort + runner. `run()` detects a cycle FIRST and
// throws (message contains "cycle") BEFORE running any task; otherwise it toposorts deterministically and runs.
// seed+golden PASSES the oracle (cycle rejection + deterministic order across independent tasks).
const { createGraph } = require("./graph.js");
const { findCycle } = require("./cycle.js");
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
      const cycle = findCycle(graph);
      if (cycle) {
        throw new Error("dependency cycle detected: " + cycle.join(" -> "));
      }
      const order = toposort(graph);
      const results = runOrder(order, tasks, (id) => graph.depsOf(id));
      return { results };
    },
  };
}

module.exports = { createScheduler };
