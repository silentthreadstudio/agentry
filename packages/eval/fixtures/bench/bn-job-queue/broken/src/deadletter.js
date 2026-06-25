// BROKEN overlay — dead-letter is correct here; the bug lives in worker.js (jobs never reach it).
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
