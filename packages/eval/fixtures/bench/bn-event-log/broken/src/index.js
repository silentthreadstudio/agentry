// GOLDEN overlay — folds every entry through the pure reducer over an empty map. seed+golden PASSES the oracle.
const { applyEntry } = require("./reducer.js");

function balances(ledger) {
  return ledger.entries().reduce(applyEntry, {});
}

module.exports = { balances };
