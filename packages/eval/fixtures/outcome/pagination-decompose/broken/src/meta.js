// BROKEN overlay — a plausible-but-WRONG "fix". seed+broken FAILS the held-out oracle.
// The bug: it reaches for Math.round instead of Math.ceil. round(10/3) = round(3.33) = 3 (still drops the partial
// page) and round(1/10) = round(0.1) = 0 (a leftover item gets no page) — so the partial-page cases still FAIL.
function pageCount(total, perPage) {
  if (total <= 0) return 0;
  return Math.round(total / perPage);
}

module.exports = { pageCount };
