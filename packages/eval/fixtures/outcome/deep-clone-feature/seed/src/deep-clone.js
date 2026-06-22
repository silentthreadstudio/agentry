// deepClone(obj) — return a deep copy that shares no nested references with the original.
//
// TODO (the planted task): implement this. It currently throws so an un-built sandbox FAILs the oracle
// (the no-leakage control) and the agent has a clear, single function to complete.
function deepClone(obj) {
  throw new Error("deepClone is not implemented yet");
}

module.exports = { deepClone };
