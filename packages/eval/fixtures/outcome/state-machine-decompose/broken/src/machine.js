// BROKEN overlay — machine.js: the PLAUSIBLE-NAIVE wiring. Instead of looking the event up in the CURRENT
// state's row and rejecting a miss, it scans the whole table for ANY state that has this event and applies the
// first match, ignoring the current state; if no state has the event it blindly sets state to the event name.
// The valid LINEAR happy path works (each event has one global target), but it APPLIES EVENTS BLINDLY: an event
// invalid from the current state is still applied (wrong transition), and a final state accepts events it must
// reject. The bug is the missing per-state guard, not an obvious stub.
const { STATES, TRANSITIONS } = require("./states.js");
const transitions = require("./transitions.js");

function create(initial) {
  const machine = {
    state: initial,
    send(event) {
      // Scan every state's row for this event (ignores the current state entirely).
      for (const state of Object.keys(transitions.TRANSITIONS)) {
        const target = transitions.TRANSITIONS[state][event];
        if (target !== undefined) {
          machine.state = target;
          return true;
        }
      }
      // Unknown event: apply it blindly as the next state name.
      machine.state = event;
      return true;
    },
  };
  return machine;
}

module.exports = { create };
