# deep-clone

A tiny CommonJS module exposing `deepClone(obj)` — return a deep copy that shares no nested references.

`src/deep-clone.js` ships a stub that throws; implement it so:

- `deepClone({ a: { b: 1 } })` is equal by value to the input
- mutating the clone at depth (`clone.a.b = 99`) leaves the original untouched

No dependencies; keep the CommonJS export (`module.exports = { deepClone }`).
