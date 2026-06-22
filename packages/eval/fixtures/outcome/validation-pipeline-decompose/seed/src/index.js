// index.js — the barrel: validate(input, rules) wrapping the runner, plus the re-exported rule factories.
//
// TODO (the planted task): implement validate. It currently throws so an un-built sandbox FAILs the oracle
// (the no-leakage control).
function validate(input, rules) {
  throw new Error("index.js is not implemented yet");
}

module.exports = { validate };
