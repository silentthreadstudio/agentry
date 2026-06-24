// Composition component. STUB — `createLRU(capacity)` ties the store + policy into an LRU. See README.
const { createStore } = require("./store.js");
const { lruVictim } = require("./policy.js");

function createLRU(capacity) {
  throw new Error("not implemented");
}

module.exports = { createLRU };
