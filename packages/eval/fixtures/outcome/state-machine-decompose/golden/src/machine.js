// GOLDEN overlay — machine.js: the barrel wiring states + transitions. send() consults the guard; an allowed
// transition advances state and returns true, a rejected one leaves state unchanged and returns false.
const { STATES } = require("./states.js");
const { nextState } = require("./transitions.js");

function create(initial) {
  if (!STATES.includes(initial)) {
    throw new Error(`invalid initial state: ${initial}`);
  }
  const machine = {
    state: initial,
    send(event) {
      const target = nextState(machine.state, event);
      if (target === undefined) return false; // reject: stay in the current state
      machine.state = target;
      return true;
    },
  };
  return machine;
}

module.exports = { create };
