// Numeric helpers. `clamp` is to be ADDED; `toFixed2` already exists and must not change.
function toFixed2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { toFixed2 };
