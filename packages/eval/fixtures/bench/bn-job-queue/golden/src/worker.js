// GOLDEN overlay — pulls ONE job, runs its handler. On success the job is done. On failure it increments the SAME
// job's attempt count (preserved across requeue) and, while below maxAttempts, re-enqueues it at the BACK so other
// jobs run first (fairness); otherwise it dead-letters. Returns whether a job was processed. seed+golden PASSES.
const { delayFor } = require("./backoff.js");

function runOnce(store, deadLetter, handler, maxAttempts) {
  const job = store.dequeue();
  if (job === undefined) return false;
  try {
    handler(job.payload);
    job.status = "done";
  } catch (err) {
    job.attempts += 1; // attempt count lives on the job, so it survives the requeue
    job.lastError = err && err.message;
    if (job.attempts < maxAttempts) {
      job.nextDelay = delayFor(job.attempts);
      store.enqueue(job); // re-enqueue at the BACK — fair, others run before this retry
    } else {
      deadLetter.add(job); // exhausted retries — permanently failed
    }
  }
  return true;
}

module.exports = { runOnce };
