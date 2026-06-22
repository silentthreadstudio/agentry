# paginate

A tiny CommonJS module exposing `paginate(items, cursor, size)` — one page of a list as `{ page, nextCursor }`.

`src/paginate.js` ships a stub that throws; implement it so the boundaries hold:

- mid-list: `paginate([1,2,3,4,5,6], 2, 2)` → `{ page: [3,4], nextCursor: 4 }`
- last page: `paginate([1,2,3,4,5,6], 4, 2)` → `{ page: [5,6], nextCursor: null }`
- past the end / empty list → `{ page: [], nextCursor: null }`

`nextCursor` MUST be `null` once no items remain. No dependencies; keep the CommonJS export
(`module.exports = { paginate }`).
