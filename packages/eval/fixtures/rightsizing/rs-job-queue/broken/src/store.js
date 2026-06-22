// BROKEN overlay — the store is implemented correctly here; the defects live in the worker and the index wiring.
function createStore() {
  const jobs = [];
  return {
    enqueue(job) {
      jobs.push(job);
    },
    dequeue() {
      return jobs.shift(); // BUG: (none here) — store is correct; defects are isolated to worker.js + index.js
    },
    size() {
      return jobs.length;
    },
  };
}

module.exports = { createStore };
