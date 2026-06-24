// GOLDEN overlay — append-only ledger. seed+golden PASSES the oracle.
function createLedger() {
  const log = [];
  return {
    post(entry) {
      log.push(entry);
    },
    entries() {
      return log.slice();
    },
  };
}

module.exports = { createLedger };
