// BROKEN overlay — states.js is correct here; the bug lives in the machine wiring, not the catalogue.
const STATES = ["draft", "review", "published", "archived"];
const FINAL = new Set(["archived"]);

function isFinal(state) {
  return FINAL.has(state);
}

module.exports = { STATES, FINAL, isFinal };
