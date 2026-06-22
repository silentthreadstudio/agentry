// GOLDEN overlay (part 3/3) — the barrel wiring the two modules. seed+golden PASSES the held-out oracle.
const { createStore } = require("./store.js");
const { lowStock } = require("./report.js");

module.exports = { createStore, lowStock };
