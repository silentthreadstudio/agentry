// BROKEN overlay — the reducer is a no-op: it ignores the event entirely, so neither `inc` nor `dec` ever changes
// the state and `replay` always returns 0 regardless of the log. The core feature (an event-sourced counter) does
// nothing. seed+broken FAILS the oracle's inc/dec assertions — the defect is isolated to the reducer.
function apply(state, event) {
  return state; // BUG: ignores the event — inc/dec never apply, so the counter never moves off 0.
}

module.exports = { apply };
