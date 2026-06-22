// BROKEN overlay — the PLAUSIBLE-NAIVE solution: a plain `{}` accumulator with the classic `acc[k] = acc[k] || []`
// pattern. Works for ordinary keys, but when `k === "toString"` (or "constructor", "hasOwnProperty"), `acc[k]`
// resolves to the INHERITED Object.prototype member — a truthy function — so the `|| []` never fires and `.push`
// is called on that function, throwing (or mis-grouping). seed+broken FAILS the oracle on the prototype-collision
// trap. The bug is the unguarded plain-object accumulator, not an obvious stub.
function groupBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    (out[key] = out[key] || []).push(item);
  }
  return out;
}

module.exports = { groupBy };
