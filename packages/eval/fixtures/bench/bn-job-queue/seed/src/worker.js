// Worker component. STUB — `runOnce(store, deadLetter, handler, maxAttempts)` pulls one job, runs its handler, and on
// failure schedules a retry (fair — back of the queue, attempt count preserved) or dead-letters after maxAttempts.
// See README.
const { delayFor } = require("./backoff.js");

function runOnce(store, deadLetter, handler, maxAttempts) {
  throw new Error("not implemented");
}

module.exports = { runOnce };
