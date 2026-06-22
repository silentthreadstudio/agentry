// machine.js — the barrel/entry: create(initial) -> { state, send }. Wires states.js + transitions.js together.
//
// TODO (the planted task): implement create(initial). It currently throws so an un-built sandbox FAILs the oracle
// (the no-leakage control).
function create(initial) {
  throw new Error("machine.js is not implemented yet");
}

module.exports = { create };
