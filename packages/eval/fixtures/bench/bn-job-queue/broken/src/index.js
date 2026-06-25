// BROKEN overlay — index is correct here; the bug lives in worker.js. Composes store + worker + dead-letter.
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
      const counting = (payload) => {
        const result = handler(payload);
        processed += 1;
        return result;
      };
      while (runOnce(store, deadLetter, counting, maxAttempts)) {
        // drain until the store is empty
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
