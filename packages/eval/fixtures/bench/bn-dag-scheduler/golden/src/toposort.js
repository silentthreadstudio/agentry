// GOLDEN overlay — deterministic Kahn's-algorithm topological sort. Ready nodes (indegree 0) are always
// taken in INSERTION order (graph.nodes() order), so independent tasks run in a stable, reproducible order
// regardless of how dependents were declared. PURE — reads the graph, mutates nothing. seed+golden PASSES.
function toposort(graph) {
  const nodes = graph.nodes(); // insertion order — the tie-break authority
  const remaining = new Map(); // id -> count of unresolved dependencies
  for (const id of nodes) {
    remaining.set(id, graph.depsOf(id).length);
  }

  const result = [];
  // Iterate to a fixed point; each pass appends every newly-ready node in insertion order,
  // which makes ties deterministic (no Set/object-key-order reliance).
  let progressed = true;
  while (result.length < nodes.length && progressed) {
    progressed = false;
    for (const id of nodes) {
      if (remaining.get(id) === 0) {
        result.push(id);
        remaining.set(id, -1); // mark as scheduled
        progressed = true;
        // decrement dependents that depend on this id
        for (const other of nodes) {
          if (remaining.get(other) > 0 && graph.depsOf(other).includes(id)) {
            remaining.set(other, remaining.get(other) - 1);
          }
        }
      }
    }
  }
  return result;
}

module.exports = { toposort };
