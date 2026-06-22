// BROKEN overlay — the worker does NO retry: a throwing handler is dropped on its FIRST throw with no second or
// third attempt, so a "throws twice then succeeds" job is lost instead of eventually processed. It also fails to
// count those dropped jobs as dead letters (they vanish silently). seed+broken FAILS the oracle.
function createWorker(store, handler) {
  return {
    drain() {
      let processed = 0;
      let job;
      while ((job = store.dequeue()) !== undefined) {
        try {
          handler(job);
          processed++;
        } catch (err) {
          // BUG: no 3-attempt retry — the job is dropped on its first throw and not counted as a dead letter,
          // so a handler that would have succeeded on attempt 2 or 3 is lost and deadLettered is never reported.
        }
      }
      return { processed }; // BUG: deadLettered is omitted entirely from the result.
    },
  };
}

module.exports = { createWorker };
