// GOLDEN overlay — PURE reducer: returns a NEW object with the amount added to the account (missing = 0); the input
// is never mutated. seed+golden PASSES the oracle.
function applyEntry(balances, entry) {
  const prev = balances[entry.account] ?? 0;
  return { ...balances, [entry.account]: prev + entry.amount };
}

module.exports = { applyEntry };
