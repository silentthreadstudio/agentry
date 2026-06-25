// HIDDEN held-out oracle — fixes the half-open boundary rule and probes both off-by-one failures. The discriminator
// pair: contiguous `[1,2)`+`[2,3)` MUST coalesce into `[1,3)` (the strict-`<` broken build wrongly splits them),
// while truly-disjoint `[1,2)`+`[3,4)` MUST stay separate (a `<=` placed wrong would wrongly merge them).
const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeIntervals } = require("../src/merge.js");
const { isValid, touches } = require("../src/interval.js");

test("merges overlapping intervals into one range", () => {
  const out = mergeIntervals([
    { start: 1, end: 4 },
    { start: 3, end: 6 },
  ]);
  assert.deepEqual(out, [{ start: 1, end: 6 }]);
});

test("the touching-boundary probe: contiguous half-open intervals coalesce", () => {
  // `[1,2)` and `[2,3)` do not overlap (2 ∉ [1,2)) but ARE contiguous → must merge into `[1,3)`.
  const out = mergeIntervals([
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ]);
  assert.deepEqual(out, [{ start: 1, end: 3 }], "touching intervals must merge into one contiguous range");
});

test("the disjoint probe: a gap keeps intervals separate", () => {
  // `[1,2)` and `[3,4)` have a gap at 2..3 → must stay separate.
  const out = mergeIntervals([
    { start: 1, end: 2 },
    { start: 3, end: 4 },
  ]);
  assert.deepEqual(out, [
    { start: 1, end: 2 },
    { start: 3, end: 4 },
  ], "truly-disjoint intervals must not merge");
});

test("sorts unsorted input by start and merges across the run", () => {
  const out = mergeIntervals([
    { start: 8, end: 10 },
    { start: 1, end: 3 },
    { start: 2, end: 6 },
    { start: 15, end: 18 },
  ]);
  assert.deepEqual(out, [
    { start: 1, end: 6 },
    { start: 8, end: 10 },
    { start: 15, end: 18 },
  ]);
});

test("does not mutate the input array or its objects", () => {
  const input = [
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  mergeIntervals(input);
  assert.deepEqual(input, snapshot, "input must be left untouched");
});

test("an empty input returns an empty array", () => {
  assert.deepEqual(mergeIntervals([]), []);
});

test("isValid accepts a proper half-open interval and rejects degenerate ones", () => {
  assert.equal(isValid({ start: 1, end: 2 }), true);
  assert.equal(isValid({ start: 2, end: 2 }), false); // empty, start == end
  assert.equal(isValid({ start: 3, end: 1 }), false); // inverted
});

test("touches treats contiguous intervals as coalescing but disjoint ones as not", () => {
  assert.equal(touches({ start: 1, end: 2 }, { start: 2, end: 3 }), true, "contiguous → touches");
  assert.equal(touches({ start: 1, end: 4 }, { start: 3, end: 6 }), true, "overlapping → touches");
  assert.equal(touches({ start: 1, end: 2 }, { start: 3, end: 4 }), false, "gap → does not touch");
});
