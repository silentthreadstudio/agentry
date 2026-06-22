# query-string

A tiny CommonJS module exposing `parseQuery(qs)` — parse a URL query string into an object.

`src/query-string.js` ships a stub that throws; implement it so:

- `parseQuery("a=1")` → `{ a: "1" }` (single key stays a string)
- `parseQuery("a=1&a=2")` → `{ a: ["1", "2"] }` (repeated key → array, in order)
- `parseQuery("b=")` → `{ b: "" }` and bare `parseQuery("c")` → `{ c: "" }` (empty/missing value → "")
- `parseQuery("a=%20")` → `{ a: " " }` and `parseQuery("a+b=c")` → `{ "a b": "c" }` (URL-decode, `+` → space)
- `parseQuery("")` → `{}`

No dependencies; keep the CommonJS export (`module.exports = { parseQuery }`).
