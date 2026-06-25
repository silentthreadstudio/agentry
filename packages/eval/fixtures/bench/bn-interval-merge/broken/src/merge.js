// BROKEN overlay — the fold itself is the obvious correct shape (sort a copy, extend on `touches`, take max end);
// the boundary bug lives in `touches` (see interval.js), which fails to coalesce contiguous intervals. seed+broken
// FAILS the oracle's touching-boundary probe.
const { touches } = require("./interval.js");

function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of sorted) {
    const current = merged[merged.length - 1];
    if (current && touches(current, iv)) {
      current.end = Math.max(current.end, iv.end);
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

module.exports = { mergeIntervals };
