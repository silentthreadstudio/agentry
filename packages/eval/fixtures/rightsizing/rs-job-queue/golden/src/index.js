// GOLDEN overlay — wires a store + worker; stats() reflects cumulative drain results plus pending store depth.
const { createStore } = require("./store.js");
const { createWorker } = require("./worker.js");

function createQueue(handler) {
  const store = createStore();
  const worker = createWorker(store, handler);
  let processed = 0;
  let deadLettered = 0;
  return {
    submit(job) {
      store.enqueue(job);
    },
    drain() {
      const result = worker.drain();
      processed += result.processed;
      deadLettered += result.deadLettered;
      return result;
    },
    stats() {
      return { processed, deadLettered, pending: store.size() };
    },
  };
}

module.exports = { createQueue };
