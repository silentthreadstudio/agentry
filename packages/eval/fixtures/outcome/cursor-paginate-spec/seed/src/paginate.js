// paginate(items, cursor, size) — one page of a list as { page, nextCursor }, with null at the boundary.
//
// TODO (the planted task): implement this. It currently throws so an un-built sandbox FAILs the oracle
// (the no-leakage control) and the agent has a clear, single function to complete.
function paginate(items, cursor, size) {
  throw new Error("paginate is not implemented yet");
}

module.exports = { paginate };
