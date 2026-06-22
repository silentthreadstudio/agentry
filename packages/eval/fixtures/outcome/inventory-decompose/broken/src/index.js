// BROKEN overlay (part 3/3) — the barrel is correct; the planted bug lives in report.js.
const { createStore } = require("./store.js");
const { lowStock } = require("./report.js");

module.exports = { createStore, lowStock };
