# csv

A tiny CommonJS module exposing `parseLine(line)` — parse one CSV record into an array of fields.

`src/csv.js` ships a stub that throws; implement it so quoting is honored:

- `parseLine('a,"b,c",d')` → `["a", "b,c", "d"]` (the quoted comma is not a separator)
- `parseLine('"he said ""hi"""')` → `['he said "hi"']` (doubled quote → literal quote)

Trim leading/trailing whitespace on each field. No dependencies; keep the CommonJS export
(`module.exports = { parseLine }`).
