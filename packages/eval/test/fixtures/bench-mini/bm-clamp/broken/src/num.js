// BROKEN overlay — `clamp` never actually clamps: it ignores lo/hi and returns n unchanged. seed+broken FAILS the
// oracle on every out-of-range case — a stub that doesn't do the job.
function toFixed2(n) {
  return Math.round(n * 100) / 100;
}

function clamp(n, lo, hi) {
  return n; // BUG: no clamping at all — lo/hi ignored, out-of-range values pass straight through.
}

module.exports = { toFixed2, clamp };
