// GOLDEN overlay — correct FIFO store. seed+golden PASSES the oracle.
function createStore() {
  const jobs = [];
  return {
    enqueue(job) {
      jobs.push(job);
    },
    dequeue() {
      return jobs.shift(); // undefined when empty
    },
    size() {
      return jobs.length;
    },
  };
}

module.exports = { createStore };
