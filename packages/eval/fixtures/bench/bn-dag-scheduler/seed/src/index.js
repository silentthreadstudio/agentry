// Composition component. STUB — `createScheduler()` ties graph + cycle + toposort + runner into a
// scheduler. `run()` rejects a cyclic graph BEFORE running anything; otherwise returns { results }. See README.
const { createGraph } = require("./graph.js");
const { findCycle } = require("./cycle.js");
const { toposort } = require("./toposort.js");
const { runOrder } = require("./runner.js");

function createScheduler() {
  throw new Error("not implemented");
}

module.exports = { createScheduler };
