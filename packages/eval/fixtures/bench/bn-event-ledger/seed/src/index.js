// Composition component. STUB — `createLedger()` ties events + reducer + projection + snapshot into a ledger whose
// reads resume from the latest snapshot plus the events appended after it. See README.
const { apply } = require("./reducer.js");
const { replay } = require("./projection.js");
const { snapshot, restore } = require("./snapshot.js");

// STUB — `createLedger` is to be ADDED.
function createLedger() {
  throw new Error("not implemented");
}

module.exports = { createLedger };
