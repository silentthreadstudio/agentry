// BROKEN overlay (supporting module — correct) — insertion-ordered dependency graph. The bug lives in index.js
// (no cycle detection); this module is correct. addTask records each id once in insertion order.
function createGraph() {
  const order = []; // ids in insertion order (the deterministic tie-break source)
  const deps = new Map(); // id -> array of dep ids (insertion order preserved)
  return {
    addTask(id, taskDeps = []) {
      if (!deps.has(id)) {
        order.push(id);
        deps.set(id, []);
      }
      for (const d of taskDeps) {
        deps.get(id).push(d);
      }
    },
    nodes() {
      return [...order];
    },
    depsOf(id) {
      return [...(deps.get(id) || [])];
    },
    indegree(id) {
      return (deps.get(id) || []).length;
    },
  };
}

module.exports = { createGraph };
