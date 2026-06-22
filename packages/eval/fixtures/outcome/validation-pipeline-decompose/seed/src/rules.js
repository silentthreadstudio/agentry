// rules.js — rule factories: required, minLength, isEmail. Each returns (input) -> null | string.
//
// TODO (the planted task): implement these. They currently throw so an un-built sandbox FAILs the oracle
// (the no-leakage control).
function required(field) {
  throw new Error("rules.js is not implemented yet");
}

function minLength(field, n) {
  throw new Error("rules.js is not implemented yet");
}

function isEmail(field) {
  throw new Error("rules.js is not implemented yet");
}

module.exports = { required, minLength, isEmail };
