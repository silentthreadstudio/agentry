// BROKEN overlay (supporting module — correct) — runs each task in the given order, passing it an object of its
// dependencies' already-computed results. The bug lives in index.js (no cycle detection), not here.
function runOrder(order, tasks, depsOf) {
  const results = {};
  for (const id of order) {
    const depResults = {};
    for (const dep of depsOf(id)) {
      depResults[dep] = results[dep];
    }
    const fn = tasks[id];
    results[id] = typeof fn === "function" ? fn(depResults) : undefined;
  }
  return results;
}

module.exports = { runOrder };
