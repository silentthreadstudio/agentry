// BROKEN overlay — the seed's bug verbatim (the discrimination control's wrong overlay). seed+broken FAILS the
// held-out oracle on the same inclusive-count / same-day / adjacent-boundary cases the untouched seed fails. This
// is identical to the shipped seed: for a bug fixture the seed IS the broken state, and this overlay makes the
// discrimination control explicit (broken must FAIL while golden PASSES).
const DAY = 24 * 60 * 60 * 1000;

function utcDay(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function daysBetween(a, b) {
  return (utcDay(b) - utcDay(a)) / DAY; // BUG: exclusive gap, missing the inclusive +1
}

function overlaps(r1, r2) {
  const end1 = utcDay(r1.end) + DAY;
  const end2 = utcDay(r2.end) + DAY;
  return utcDay(r1.start) <= end2 && utcDay(r2.start) <= end1; // BUG: adjacent counts as overlap
}

module.exports = { daysBetween, overlaps };
