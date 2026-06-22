// GOLDEN overlay — states.js: the state catalogue + final-state predicate.
const STATES = ["draft", "review", "published", "archived"];
const FINAL = new Set(["archived"]);

function isFinal(state) {
  return FINAL.has(state);
}

module.exports = { STATES, FINAL, isFinal };
