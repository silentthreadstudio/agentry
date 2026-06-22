// BROKEN overlay — the PLAUSIBLE-NAIVE solution: recurse fully, ignoring the `depth` parameter entirely. It
// always flattens all the way down, so it passes the default-deep cases but FAILS every finite-depth case
// (depth 0/1/2 still come back fully flattened). seed+broken FAILS the oracle on the depth trap. The bug is the
// dropped `depth`, not an obvious stub.
function flatten(arr, depth = Infinity) {
  const out = [];
  for (const item of arr) {
    if (Array.isArray(item)) {
      out.push(...flatten(item));
    } else {
      out.push(item);
    }
  }
  return out;
}

module.exports = { flatten };
