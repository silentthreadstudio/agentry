// GOLDEN overlay — transitions.js: the transition table + the guard. The guard consults the table for the CURRENT
// state; a missing entry (including any event from a final state, which has no table row) returns undefined =>
// the machine will reject and stay put.
const { isFinal } = require("./states.js");

const TRANSITIONS = {
  draft: { submit: "review" },
  review: { approve: "published", reject: "draft" },
  published: { archive: "archived" },
  // archived has no outgoing transitions (final).
};

function nextState(state, event) {
  if (isFinal(state)) return undefined; // final states accept no events
  const row = TRANSITIONS[state];
  if (!row) return undefined;
  return row[event]; // undefined when the event is not allowed from this state
}

module.exports = { TRANSITIONS, nextState };
