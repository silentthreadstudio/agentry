// BROKEN overlay — store is correct here; the bug lives in worker.js. FIFO over an array.
function createStore() {
  const items = [];
  return {
    enqueue(job) {
      items.push(job);
    },
    dequeue() {
      return items.shift();
    },
    peek() {
      return items[0];
    },
    size() {
      return items.length;
    },
    // BROKEN overlay extension: requeue at the FRONT — used by the buggy worker's immediate-retry path.
    unshift(job) {
      items.unshift(job);
    },
  };
}

module.exports = { createStore };
