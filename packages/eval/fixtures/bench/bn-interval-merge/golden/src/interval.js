// GOLDEN overlay — `touches` treats half-open intervals as coalescing when contiguous: a and b should merge when
// neither starts strictly AFTER the other ends, i.e. `a.start <= b.end && b.start <= a.end`. With contiguous
// `[1,2)` and `[2,3)` the boundaries are equal (2 <= 2), so they touch and merge; disjoint `[1,2)` and `[3,4)` have
// a gap (3 > 2), so they don't. seed+golden PASSES the oracle.
function isValid(iv) {
  return (
    iv != null &&
    Number.isFinite(iv.start) &&
    Number.isFinite(iv.end) &&
    iv.start < iv.end
  );
}

function touches(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

module.exports = { isValid, touches };
