# interpolate

A tiny CommonJS module exposing `interpolate(template, values)` — fill `{key}` placeholders from `values`.

`src/interpolate.js` ships a stub that throws; implement it so:

- `interpolate("Hi {name}", { name: "Ada" })` → `"Hi Ada"`
- `interpolate("Hi {name}", {})` → `"Hi {name}"` (missing key stays literal — never `undefined`)
- `interpolate("{{not a var}}", {})` → `"{not a var}"` (`{{`/`}}` escape to literal braces)

No dependencies; keep the CommonJS export (`module.exports = { interpolate }`).
