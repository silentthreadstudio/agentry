# date-range (working-but-wrong — fix the bugs)

A tiny CommonJS module for inclusive date ranges. `src/date-range.js` RUNS, but it is wrong on the boundaries.
Fix it without changing the public API (`module.exports = { daysBetween, overlaps }`).

All dates are `Date` objects; only the calendar DAY matters (compare at UTC-day granularity, so a time-of-day
component never changes the answer).

## `daysBetween(a, b)` — inclusive whole-day count (`a <= b`)

The number of whole days COVERED by the range, counting both ends.

- same calendar day -> `1`
- Jan 1 -> Jan 2 -> `2`
- Jan 1 -> Jan 3 -> `3`

The shipped code is off by one (it returns the exclusive gap: same day -> 0, Jan 1..Jan 3 -> 2).

## `overlaps(r1, r2)` — do two inclusive ranges share at least one whole day?

Each range is `{ start, end }` (`Date`s, `start <= end`, both ends inclusive). They overlap iff there is at least
one calendar day inside BOTH ranges.

- `[Jan 1, Jan 5]` and `[Jan 3, Jan 9]` -> overlap (share Jan 3..Jan 5)
- `[Jan 1, Jan 5]` and `[Jan 5, Jan 9]` -> overlap (share the boundary day Jan 5)
- `[Jan 1, Jan 5]` and `[Jan 6, Jan 9]` -> NO overlap (merely adjacent, no shared day)
- `[Jan 1, Jan 1]` and `[Jan 1, Jan 1]` -> overlap (same single day)

The shipped code gets the boundary wrong: it treats merely-adjacent ranges (Jan 1..Jan 5 and Jan 6..Jan 9) as
overlapping.

No dependencies; keep the CommonJS export.
