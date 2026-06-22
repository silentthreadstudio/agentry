// BROKEN overlay — `clamp` never actually clamps: it ignores `lo`/`hi` and returns `n` unchanged, so the core
// intent (bound n into [lo,hi]) is absent. clamp(-3,0,10) yields -3 (should be 0) and clamp(99,0,10) yields 99
// (should be 10). seed+broken FAILS the oracle on every out-of-range case — a stub that doesn't do the job.
function toFixed2(n) {
  return Math.round(n * 100) / 100;
}

function clamp(n, lo, hi) {
  return n; // BUG: no clamping at all — lo/hi are ignored, out-of-range values pass straight through.
}

module.exports = { toFixed2, clamp };
