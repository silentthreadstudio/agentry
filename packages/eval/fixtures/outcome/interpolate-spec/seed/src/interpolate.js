// interpolate(template, values) — fill {key} placeholders; leave unknown keys literal; {{ }} escape to braces.
//
// TODO (the planted task): implement this. It currently throws so an un-built sandbox FAILs the oracle
// (the no-leakage control) and the agent has a clear, single function to complete.
function interpolate(template, values) {
  throw new Error("interpolate is not implemented yet");
}

module.exports = { interpolate };
