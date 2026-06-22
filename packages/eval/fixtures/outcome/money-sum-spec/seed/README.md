# money

A tiny CommonJS module exposing `sumPrices(prices)` — sum a list of dollar amounts to an exact cents total.

`src/money.js` ships a stub that throws; implement it so:

- `sumPrices([0.1, 0.2])` → `0.3` (no float drift)
- `sumPrices([1.005])` → `1.01` (half-up on the .005 tie, despite the `1.005*100` float)

Round the TOTAL to exactly 2 decimals with HALF-UP rounding; no IEEE-754 drift. No dependencies; keep the
CommonJS export (`module.exports = { sumPrices }`).
