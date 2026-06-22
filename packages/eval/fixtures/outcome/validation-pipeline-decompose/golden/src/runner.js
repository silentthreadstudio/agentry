// GOLDEN overlay — runner.js: run rules IN ORDER, SHORT-CIRCUIT on the first failure (later rules never run).
function runRules(input, rules) {
  for (const rule of rules) {
    const message = rule(input);
    if (message !== null && message !== undefined) {
      return message; // first failure wins; stop here
    }
  }
  return null; // all passed
}

module.exports = { runRules };
