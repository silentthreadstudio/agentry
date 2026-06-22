// BROKEN overlay — the log is implemented correctly here; the defect is isolated to the reducer.
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
