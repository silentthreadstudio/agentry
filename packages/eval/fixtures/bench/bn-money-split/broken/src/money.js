// BROKEN overlay — the OBVIOUS solution: divide as a float and round each share independently. For 1000 / 3 each
// share rounds to 333, summing to 999 — a cent VANISHES. seed+broken FAILS the oracle's sum-back probe.
function formatCents(c) {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function splitAmount(totalCents, n) {
  const each = Math.round(totalCents / n); // BUG: rounds each share independently — shares don't sum back to total.
  const shares = [];
  for (let i = 0; i < n; i++) shares.push(each);
  return shares;
}

module.exports = { formatCents, splitAmount };
