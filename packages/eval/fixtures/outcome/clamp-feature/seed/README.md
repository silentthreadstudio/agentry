# clamp

A tiny CommonJS module exposing `clamp(n, lo, hi)` — constrain a number to an inclusive range.

`src/clamp.js` ships a stub that throws; implement it so the examples in the task hold:

- `clamp(5, 0, 10)` → `5`
- `clamp(-3, 0, 10)` → `0`
- `clamp(42, 0, 10)` → `10`

No dependencies; keep the CommonJS export (`module.exports = { clamp }`).
