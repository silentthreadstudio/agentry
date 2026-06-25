# interval-merge

Merge overlapping time intervals across two files with clean seams. Intervals are HALF-OPEN `[start, end)`,
each `{ start, end }`.
- `src/interval.js` — `isValid(iv)` (`true` only when `start`/`end` are finite and `start < end`) and
  `touches(a, b)` (`true` when `a` and `b` overlap OR are exactly contiguous and should coalesce).
- `src/merge.js` — `mergeIntervals(intervals)` → a NEW sorted-by-`start` array of merged `{ start, end }`,
  without mutating the input.

THE RULE: because intervals are half-open, `[1,2)` and `[2,3)` do NOT overlap (2 ∉ `[1,2)`) but ARE
contiguous, so they MUST merge into `[1,3)`; truly-disjoint `[1,2)` and `[3,4)` MUST stay separate.

The seed ships `isValid` complete and `touches`/`mergeIntervals` as stubs; fill them in. Keep CommonJS
exports. No dependencies.
