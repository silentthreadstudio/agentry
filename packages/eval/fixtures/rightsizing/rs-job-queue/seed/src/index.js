// Queue wiring component. STUB — wire a store + worker into `createQueue`. See README.
const { createStore } = require("./store.js");
const { createWorker } = require("./worker.js");

function createQueue(handler) {
  throw new Error("not implemented");
}

module.exports = { createQueue };
