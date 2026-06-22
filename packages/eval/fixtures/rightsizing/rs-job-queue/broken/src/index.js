// BROKEN overlay — wiring inherits the worker's missing retry; on top of that, stats() accounting is wrong:
// deadLettered is hard-coded to 0 and pending is always reported as 0 instead of the real store depth.
const { createStore } = require("./store.js");
const { createWorker } = require("./worker.js");

function createQueue(handler) {
  const store = createStore();
  const worker = createWorker(store, handler);
  let processed = 0;
  return {
    submit(job) {
      store.enqueue(job);
    },
    drain() {
      const result = worker.drain();
      processed += result.processed;
      return result;
    },
    stats() {
      // BUG: deadLettered is hard-coded to 0 (never tracked) and pending is always 0 instead of store.size().
      return { processed, deadLettered: 0, pending: 0 };
    },
  };
}

module.exports = { createQueue };
