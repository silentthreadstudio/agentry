// Interval helpers over HALF-OPEN intervals `[start, end)`, each `{ start, end }`. `isValid` is complete; `touches`
// is to be ADDED. The subtle trap is the boundary: half-open `[1,2)` and `[2,3)` are contiguous (must coalesce),
// while `[1,2)` and `[3,4)` have a gap (must stay separate). See README.
function isValid(iv) {
  return (
    iv != null &&
    Number.isFinite(iv.start) &&
    Number.isFinite(iv.end) &&
    iv.start < iv.end
  );
}

// STUB — `touches(a, b)` is to be ADDED: true when a and b overlap OR are exactly contiguous.
function touches(a, b) {
  throw new Error("not implemented");
}

module.exports = { isValid, touches };
