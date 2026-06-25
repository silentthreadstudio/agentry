// GOLDEN overlay — the dead-letter sink: `add` appends a permanently-failed job, `list` returns a copy, `size` is
// the count. seed+golden PASSES the oracle.
function createDeadLetter() {
  const failed = [];
  return {
    add(job) {
      failed.push(job);
    },
    list() {
      return [...failed];
    },
    size() {
      return failed.length;
    },
  };
}

module.exports = { createDeadLetter };
