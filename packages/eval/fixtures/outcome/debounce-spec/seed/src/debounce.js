// debounce(fn, ms) — return a wrapper that coalesces a burst of calls into one trailing call after `ms` quiet.
//
// TODO (the planted task): implement this. It currently throws so an un-built sandbox FAILs the oracle
// (the no-leakage control) and the agent has a clear, single function to complete.
function debounce(fn, ms) {
  throw new Error("debounce is not implemented yet");
}

module.exports = { debounce };
