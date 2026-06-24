// GOLDEN overlay — step one UTC day at a time, counting a step only when it LANDS on a business day; weekends are
// stepped over without consuming `n`. n=0 returns the input unchanged. seed+golden PASSES the oracle.
function addBusinessDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay(); // 0 Sun .. 6 Sat
    if (day !== 0 && day !== 6) added += 1;
  }
  return d.toISOString().slice(0, 10);
}

module.exports = { addBusinessDays };
