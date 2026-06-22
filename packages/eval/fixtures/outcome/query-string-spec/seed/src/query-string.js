// parseQuery(qs) — parse a URL query string into an object (repeats -> array, empty -> "", URL-decoded).
//
// TODO (the planted task): implement this. It currently throws so an un-built sandbox FAILs the oracle
// (the no-leakage control) and the agent has a clear, single function to complete.
function parseQuery(qs) {
  throw new Error("parseQuery is not implemented yet");
}

module.exports = { parseQuery };
