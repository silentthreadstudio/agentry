// BROKEN overlay — backoff is correct here; the bug lives in worker.js. PURE capped exponential.
function delayFor(attempt) {
  const base = 100 * Math.pow(2, attempt - 1);
  return Math.min(base, 5000);
}

module.exports = { delayFor };
