// GOLDEN overlay — integer-cent split: base = floor(total/n), the leftover `total % n` cents go to the earliest
// shares one at a time, so the parts sum back EXACTLY. seed+golden PASSES the oracle.
function formatCents(c) {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function splitAmount(totalCents, n) {
  const base = Math.floor(totalCents / n);
  let remainder = totalCents - base * n;
  const shares = [];
  for (let i = 0; i < n; i++) {
    shares.push(base + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder -= 1;
  }
  return shares;
}

module.exports = { formatCents, splitAmount };
