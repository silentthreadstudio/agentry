// GOLDEN overlay — correct append-only log. seed+golden PASSES the oracle.
function createLog() {
  const events = [];
  return {
    append(event) {
      events.push(event);
    },
    all() {
      return events.slice();
    },
  };
}

module.exports = { createLog };
