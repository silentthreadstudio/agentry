// BROKEN overlay — the OBVIOUS shortcut: add `n` CALENDAR days, then nudge a weekend landing to Monday. This
// under-counts whenever the n-day span crosses a weekend (the intervening Sat/Sun were silently counted toward n),
// so it lands a business day SHORT. seed+broken FAILS the oracle's cross-weekend probe.
function addBusinessDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n); // BUG: counts weekend days toward n — undercounts across a Sat/Sun span.
  const day = d.getUTCDay();
  if (day === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (day === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = { addBusinessDays };
