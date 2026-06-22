# slugify

A tiny CommonJS module exposing `slugify(title)` — turns a human title into a URL slug.

`src/slugify.js` ships a stub that throws; implement it so the examples in the task hold:

- `slugify("  Hello, World!  ")` → `"hello-world"`
- `slugify("Node.js  &  TS")` → `"node-js-ts"`

No dependencies; keep the CommonJS export (`module.exports = { slugify }`).
