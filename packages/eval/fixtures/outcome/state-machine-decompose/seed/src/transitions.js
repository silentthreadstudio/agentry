// transitions.js — the transition table + the guard that decides whether an event is allowed from a state.
//
// TODO (the planted task): implement TRANSITIONS and nextState(state, event). It currently throws so an un-built
// sandbox FAILs the oracle (the no-leakage control).
function nextState(state, event) {
  throw new Error("transitions.js is not implemented yet");
}

module.exports = { TRANSITIONS: undefined, nextState };
