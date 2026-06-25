// GOLDEN overlay — snapshot/restore via a deep copy, so a round-trip deep-equals the state and shares no mutable
// references with it. seed+golden PASSES the oracle's snapshot-isolation probe.
function deepCopyState(state) {
  const src = state && state.balances ? state.balances : {};
  return { balances: { ...src } };
}

function snapshot(state) {
  return deepCopyState(state);
}

function restore(snap) {
  return deepCopyState(snap);
}

module.exports = { snapshot, restore };
