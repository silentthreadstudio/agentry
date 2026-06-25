// GOLDEN overlay — composes the store + worker + dead-letter. `add` enqueues a fresh job wrapping the payload (with
// its own attempt counter); `process(handler)` drains the queue, counting successful completions; `stats()` reports
// pending / deadLettered / processed. seed+golden PASSES the oracle.
const { createStore } = require("./store.js");
const { createDeadLetter } = require("./deadletter.js");
const { runOnce } = require("./worker.js");

function createQueue({ maxAttempts }) {
  const store = createStore();
  const deadLetter = createDeadLetter();
  let processed = 0;

  return {
    add(payload) {
      store.enqueue({ payload, attempts: 0, status: "pending" });
    },
    process(handler) {
      // wrap the handler to count a completion only when it succeeds (the throw propagates to the worker for retry).
      const counting = (payload) => {
        const result = handler(payload);
        processed += 1;
        return result;
      };
      while (runOnce(store, deadLetter, counting, maxAttempts)) {
        // drain until the store is empty (runOnce returns false on an empty store)
      }
    },
    stats() {
      return {
        pending: store.size(),
        deadLettered: deadLetter.size(),
        processed,
      };
    },
  };
}

module.exports = { createQueue };
