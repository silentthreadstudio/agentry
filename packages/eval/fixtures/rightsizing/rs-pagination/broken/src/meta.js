// BROKEN overlay — the plausible-WRONG page math: it FLOORS instead of ceiling, dropping the final partial page.
// pageCount(5, 2) returns 2 (should be 3). seed+broken FAILS the oracle.
function pageCount(total, perPage) {
  if (perPage <= 0) return 0;
  return Math.floor(total / perPage); // BUG: drops the last partial page.
}

module.exports = { pageCount };
