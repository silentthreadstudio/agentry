// date-range.js — inclusive date ranges. WORKING BUT WRONG (the planted bug, ADR-003 bug-kind fixture).
//
// Both functions run and look plausible, but:
//   - daysBetween is OFF BY ONE: it returns the exclusive gap (same day -> 0), not the inclusive count.
//   - overlaps gets the BOUNDARY wrong: by using "<=" against an end-exclusive (end + 1 day) boundary it counts
//     merely-ADJACENT ranges (Jan 1..Jan 5 and Jan 6..Jan 9) as overlapping.
// The held-out oracle fails on the inclusive-count, same-day, and adjacent-boundary cases until both are fixed.
const DAY = 24 * 60 * 60 * 1000;

// Truncate a Date to its UTC calendar day (ms since epoch at 00:00 UTC) so time-of-day never skews the math.
function utcDay(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function daysBetween(a, b) {
  return (utcDay(b) - utcDay(a)) / DAY; // BUG: exclusive gap, missing the inclusive +1
}

function overlaps(r1, r2) {
  const end1 = utcDay(r1.end) + DAY; // end-exclusive boundary (day after the inclusive end)
  const end2 = utcDay(r2.end) + DAY;
  // BUG: "<=" against an exclusive boundary lets adjacent ranges (r2 starts the day after r1 ends) count as overlap.
  return utcDay(r1.start) <= end2 && utcDay(r2.start) <= end1;
}

module.exports = { daysBetween, overlaps };
