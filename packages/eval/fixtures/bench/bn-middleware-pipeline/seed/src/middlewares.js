// Concrete middlewares. STUB — `auth`, `validate`, `rateLimit`, `responder` are to be ADDED. See README.
const { send } = require("./context.js");

function auth() {
  throw new Error("not implemented");
}

function validate() {
  throw new Error("not implemented");
}

function rateLimit(limit) {
  throw new Error("not implemented");
}

function responder() {
  throw new Error("not implemented");
}

module.exports = { auth, validate, rateLimit, responder };
