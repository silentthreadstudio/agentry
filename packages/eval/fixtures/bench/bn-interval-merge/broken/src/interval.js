// BROKEN overlay — the OBVIOUS strict-overlap reading: treat two intervals as touching only when they actually
// OVERLAP (`a.start < b.end && b.start < a.end`), using strict `<`. This is correct for genuinely overlapping
// intervals but is an off-by-one on the boundary: contiguous half-open `[1,2)` and `[2,3)` have b.start (2) == a.end
// (2), so `2 < 2` is false and they are wrongly SPLIT instead of coalescing into `[1,3)`. seed+broken FAILS the
// oracle's touching-boundary probe.
function isValid(iv) {
  return (
    iv != null &&
    Number.isFinite(iv.start) &&
    Number.isFinite(iv.end) &&
    iv.start < iv.end
  );
}

function touches(a, b) {
  // BUG: strict `<` only detects true overlap, so contiguous (touching) intervals are wrongly kept separate.
  return a.start < b.end && b.start < a.end;
}

module.exports = { isValid, touches };
