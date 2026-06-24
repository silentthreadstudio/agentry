# Spec: add `average(xs)` to the math utilities

## Job-to-be-done
Callers need the arithmetic mean of a numeric list. Today they hand-roll `sum/length`, which silently yields `NaN`
on the empty list — a latent bug surfaced in three call sites.

## Decisions surfaced (the load-bearing forks)
1. **Empty-array semantics** — `average([])` must return a defined value. Assumption: return `0` (the additive
   identity), not `NaN` or a throw, because every caller treats "no data" as "0 contribution".
   Override: if a caller needs to distinguish empty-from-zero, return `null` instead — change the guard's return.
2. **Input type discipline** — assume all elements are finite numbers (the callers already validate upstream).
   Override: add a `Number.isFinite` filter if a caller can pass `NaN`/`Infinity`.

## Scope
In: the `average` function + the empty-array guard + its export. Out (non-goals): streaming/online averaging,
weighted averages, BigInt support — none of the three call sites need them.

## Acceptance
- `average([2,4,6]) === 4`; `average([]) === 0`; existing exports untouched.
