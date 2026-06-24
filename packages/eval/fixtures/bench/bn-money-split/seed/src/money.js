// Money helpers in integer CENTS. `splitAmount` is to be ADDED (see README); `formatCents` already exists and
// must not change.
function formatCents(c) {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

module.exports = { formatCents };
