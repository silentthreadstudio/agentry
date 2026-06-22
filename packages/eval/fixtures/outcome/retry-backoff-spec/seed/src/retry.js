// retry(fn, opts) — retry an async fn with capped exponential backoff, honoring isRetryable + the attempt cap.
//
// TODO (the planted task): implement this. It currently throws so an un-built sandbox FAILs the oracle
// (the no-leakage control) and the agent has a clear, single function to complete.
async function retry(fn, opts) {
  throw new Error("retry is not implemented yet");
}

module.exports = { retry };
