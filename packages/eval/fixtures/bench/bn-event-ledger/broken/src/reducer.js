// GOLDEN overlay — PURE reducer: returns a NEW state with balances updated (missing account = 0); never mutates the
// input state or its balances map. seed+golden PASSES the oracle's purity probe.
function apply(state, event) {
  const balances = { ...(state && state.balances ? state.balances : {}) };
  const bal = (acct) => balances[acct] ?? 0;
  switch (event.type) {
    case "deposit":
      balances[event.account] = bal(event.account) + event.amount;
      break;
    case "withdraw":
      balances[event.account] = bal(event.account) - event.amount;
      break;
    case "transfer":
      balances[event.from] = bal(event.from) - event.amount;
      balances[event.to] = bal(event.to) + event.amount;
      break;
    default:
      throw new Error(`unknown event type: ${event.type}`);
  }
  return { balances };
}

module.exports = { apply };
