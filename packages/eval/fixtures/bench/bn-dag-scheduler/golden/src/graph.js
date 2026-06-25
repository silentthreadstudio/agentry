// GOLDEN overlay — insertion-ordered dependency graph. addTask records each id once in insertion order;
// depsOf returns the declared dependencies; indegree is the count of declared deps. seed+golden PASSES.
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
