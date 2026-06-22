// GOLDEN overlay — replay folds the whole log over initial state 0.
const { apply } = require("./reducer.js");

function replay(log) {
  return log.all().reduce((state, event) => apply(state, event), 0);
}

module.exports = { replay };
