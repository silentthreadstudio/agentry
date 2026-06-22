// GOLDEN overlay — accumulate into a null-prototype object so a key like "toString" can never collide with an
// inherited Object.prototype member; order is preserved by iterating items once. seed+golden PASSES the oracle.
function groupBy(items, keyFn) {
  const out = Object.create(null);
  for (const item of items) {
    const key = keyFn(item);
    if (out[key] === undefined) out[key] = [];
    out[key].push(item);
  }
  return out;
}

module.exports = { groupBy };
