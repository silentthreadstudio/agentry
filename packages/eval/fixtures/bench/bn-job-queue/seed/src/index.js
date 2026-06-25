// Composition component. STUB — `createQueue({ maxAttempts })` ties the store + worker + dead-letter into a queue.
// See README.
const { createStore } = require("./store.js");
const { createDeadLetter } = require("./deadletter.js");
const { runOnce } = require("./worker.js");

function createQueue({ maxAttempts }) {
  throw new Error("not implemented");
}

module.exports = { createQueue };
