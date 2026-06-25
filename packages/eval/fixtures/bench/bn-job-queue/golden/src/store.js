// GOLDEN overlay — a FIFO store over an array. `enqueue` appends to the back, `dequeue` removes from the front,
// `peek` reads the front without removing, `size` is the count. seed+golden PASSES the oracle.
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
  };
}

module.exports = { createStore };
