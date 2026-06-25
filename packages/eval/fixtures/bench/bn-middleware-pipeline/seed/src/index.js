// Composition component. STUB — `createApp(middlewareOrder)` ties context + compose + middlewares + errors into an
// app. See README.
const { createContext } = require("./context.js");
const { compose } = require("./compose.js");
const { errorResponse } = require("./errors.js");

function createApp(middlewareOrder) {
  throw new Error("not implemented");
}

module.exports = { createApp };
