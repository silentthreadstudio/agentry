# dag-scheduler

A task scheduler over a dependency DAG, across five files with clean seams:
- `src/graph.js` — `createGraph()` → `{ addTask(id, deps), nodes(), depsOf(id), indegree(id) }`, an
  insertion-ordered adjacency + indegree model.
- `src/toposort.js` — PURE `toposort(graph)` → a deterministic run order (array of ids). Ties (nodes ready
  at the same time) are broken by INSERTION order — the order tasks were added via `addTask`.
- `src/cycle.js` — PURE `findCycle(graph)` → the list of ids forming a cycle, or `null` when the graph is acyclic.
- `src/runner.js` — `runOrder(order, tasks, depsOf)` runs each task in `order`, passing it an object of its
  dependencies' results (`{ [depId]: result }`); returns `{ [id]: result }`.
- `src/index.js` — `createScheduler()` → `{ add(id, deps, fn), run() }`. `run()` rejects a cyclic graph
  BEFORE running anything (throws an Error whose message contains "cycle"); otherwise returns `{ results }`.

The seed ships stub signatures; fill them in. Keep CommonJS exports. No dependencies.
