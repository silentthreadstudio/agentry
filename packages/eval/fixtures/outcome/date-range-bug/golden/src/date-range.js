// GOLDEN overlay — the FIX. daysBetween is the INCLUSIVE day count (+1), and overlaps uses the inclusive
// half-open-free test on UTC days: two inclusive ranges share a day iff start1 <= end2 AND start2 <= end1, so
// merely-adjacent ranges (no shared day) do not overlap. seed+golden PASSES the held-out oracle.
const DAY = 24 * 60 * 60 * 1000;

function utcDay(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function daysBetween(a, b) {
  return (utcDay(b) - utcDay(a)) / DAY + 1; // inclusive: same day -> 1, Jan 1..Jan 3 -> 3
}

function overlaps(r1, r2) {
  // Inclusive ranges overlap iff each starts on or before the other ends (compared at UTC-day granularity).
  return utcDay(r1.start) <= utcDay(r2.end) && utcDay(r2.start) <= utcDay(r1.end);
}

module.exports = { daysBetween, overlaps };
