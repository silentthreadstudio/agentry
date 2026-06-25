// GOLDEN overlay — runs each task in the given order, passing it an object of its dependencies' already-computed
// results. Because `order` is a valid topological order, every dep is present before its dependent runs.
// Returns a results map keyed by id. seed+golden PASSES.
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
