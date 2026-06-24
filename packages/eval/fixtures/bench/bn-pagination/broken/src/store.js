// GOLDEN overlay — insertion-ordered in-memory store. seed+golden PASSES the oracle.
function createStore() {
  const records = [];
  return {
    add(record) {
      records.push(record);
    },
    all() {
      return records.slice();
    },
  };
}

module.exports = { createStore };
