// GOLDEN overlay — correct pure reducer; default `by` is 1; unknown types pass through.
function apply(state, event) {
  const by = event.by === undefined ? 1 : event.by;
  if (event.type === "inc") return state + by;
  if (event.type === "dec") return state - by;
  return state;
}

module.exports = { apply };
