// GOLDEN overlay — replay folds `apply` over the events from `initialState` (nullish = empty). Because `apply` is
// pure, `initialState` is never mutated. seed+golden PASSES the oracle.
const { apply } = require("./reducer.js");

function replay(initialState, events) {
  let state = initialState ?? { balances: {} };
  for (const event of events) {
    state = apply(state, event);
  }
  return state;
}

module.exports = { replay };
