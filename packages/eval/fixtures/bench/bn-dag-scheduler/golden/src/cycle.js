// GOLDEN overlay — DFS cycle detection over the dependency edges (id -> its deps). Returns the ids on the
// first cycle found (the back-edge path), or null when acyclic. PURE — reads the graph only. seed+golden PASSES.
function findCycle(graph) {
  const nodes = graph.nodes();
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(nodes.map((id) => [id, WHITE]));
  const stack = [];

  function visit(id) {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of graph.depsOf(id)) {
      if (!color.has(dep)) continue; // dep not a known node — ignore (not a cycle)
      if (color.get(dep) === GRAY) {
        // back edge — extract the cycle from the current stack
        const from = stack.indexOf(dep);
        return stack.slice(from);
      }
      if (color.get(dep) === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  }

  for (const id of nodes) {
    if (color.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

module.exports = { findCycle };
