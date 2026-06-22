# group-by

A tiny CommonJS module exposing `groupBy(items, keyFn)` — group items into an object of arrays by `keyFn(item)`.

`src/group-by.js` ships a stub that throws; implement it so:

- `groupBy([1, 2, 3, 4], n => n % 2 === 0 ? "even" : "odd")` → `{ odd: [1, 3], even: [2, 4] }`
- items keep their original order within each group
- a key that collides with a built-in member name (e.g. `"toString"`) still groups correctly — use a
  null-prototype object or a Map internally so prototype members never leak in

No dependencies; keep the CommonJS export (`module.exports = { groupBy }`).
