// GOLDEN overlay — PURE capped exponential backoff: attempt 1 → 100, 2 → 200, 3 → 400, doubling per attempt, capped
// at 5000 ms. seed+golden PASSES the oracle.
function delayFor(attempt) {
  const base = 100 * Math.pow(2, attempt - 1);
  return Math.min(base, 5000);
}

module.exports = { delayFor };
