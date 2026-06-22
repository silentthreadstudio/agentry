# flatten

A tiny CommonJS module exposing `flatten(arr, depth = Infinity)` — flatten nested arrays up to `depth` levels.

`src/flatten.js` ships a stub that throws; implement it so:

- `flatten([1, [2, [3, [4]]]])` → `[1, 2, 3, 4]` (default: fully deep)
- `flatten([1, [2, [3, [4]]]], 1)` → `[1, 2, [3, [4]]]` (one level only)
- `flatten([1, [2, [3]]], 0)` → `[1, [2, [3]]]` (no flattening)

No dependencies (don't delegate to `Array.prototype.flat`); keep the CommonJS export
(`module.exports = { flatten }`).
