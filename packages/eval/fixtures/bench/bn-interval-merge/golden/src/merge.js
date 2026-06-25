// GOLDEN overlay — sort a COPY by start, then fold: extend the current run when the next interval `touches` it
// (overlapping OR contiguous), taking the max end; otherwise push the run and start a new one. Returns a NEW array
// of fresh `{ start, end }` objects, never mutating the input. seed+golden PASSES the oracle.
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
