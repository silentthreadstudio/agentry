// BROKEN overlay — the replay assembler is wired correctly; it inherits the wrong totals from the broken reducer.
const { apply } = require("./reducer.js");

function replay(log) {
  return log.all().reduce((state, event) => apply(state, event), 0);
}

module.exports = { replay };
