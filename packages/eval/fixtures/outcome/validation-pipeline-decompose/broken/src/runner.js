// BROKEN overlay — runner.js: the PLAUSIBLE-NAIVE runner. It runs EVERY rule and collects ALL failures instead of
// short-circuiting on the first one, returning an array of messages. The all-pass path still yields an empty
// array, but on failure it returns every failing rule's message (no short-circuit, wrong count/shape). The bug is
// the missing short-circuit, not an obvious stub.
function runRules(input, rules) {
  const messages = [];
  for (const rule of rules) {
    const message = rule(input);
    if (message !== null && message !== undefined) {
      messages.push(message); // keeps going — no short-circuit
    }
  }
  return messages; // returns an ARRAY of all failures, not the first message
}

module.exports = { runRules };
