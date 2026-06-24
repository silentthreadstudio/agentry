// BROKEN overlay — the reducer MUTATES the input balances and returns it, instead of returning a new object. The
// fold still sums correctly, but the contract's purity (no mutation) is violated, so a caller that snapshots an
// intermediate balances sees it change underneath them. seed+broken FAILS the oracle's no-mutation probe.
function applyEntry(balances, entry) {
  balances[entry.account] = (balances[entry.account] ?? 0) + entry.amount; // BUG: mutates the input — not pure.
  return balances;
}

module.exports = { applyEntry };
