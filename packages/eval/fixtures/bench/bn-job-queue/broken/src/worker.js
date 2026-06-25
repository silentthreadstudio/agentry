// BROKEN overlay — the plausible-but-wrong retry: on failure it re-enqueues at the FRONT for an immediate retry and
// rebuilds the job as a FRESH object, so the attempt count is LOST (reset to 0) on every requeue. The queue still
// stores, runs, and returns; the bug only surfaces when modules interact across a retry: the failing job starves the
// others (front-requeue) and never dead-letters (attempts never accumulate past maxAttempts). seed+broken FAILS the
// oracle's fairness + dead-letter probes.
const { delayFor } = require("./backoff.js");

function runOnce(store, deadLetter, handler, maxAttempts) {
  const job = store.dequeue();
  if (job === undefined) return false;
  try {
    handler(job.payload);
    job.status = "done";
  } catch (err) {
    // BUG: rebuild a fresh job (attempts reset to 0) and push it to the FRONT for an immediate retry — this loses the
    // attempt count so the job never dead-letters, and it starves every other queued job.
    const retry = { payload: job.payload, attempts: 0, status: "pending", lastError: err && err.message };
    if (retry.attempts < maxAttempts) {
      retry.nextDelay = delayFor(retry.attempts + 1);
      store.unshift(retry); // re-enqueue at the FRONT — not fair
    } else {
      deadLetter.add(retry);
    }
  }
  return true;
}

module.exports = { runOnce };
