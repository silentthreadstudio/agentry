# mini-router

A tiny CommonJS path router split across THREE coordinating modules. Each file in `src/` ships a stub that
throws; implement them so param extraction, route precedence, and trailing slashes are all handled correctly.

## The three modules

- `src/match.js` — `matches(pattern, path)`: split both into segments (on `/`, ignoring a trailing slash) and
  compare segment by segment. A `:name` pattern segment matches any single path segment; a literal segment must
  equal the path segment. Different segment counts never match. Returns a boolean.
- `src/params.js` — `extractParams(pattern, path)`: given a pattern and a path that matches it, return a plain
  object mapping each `:name` segment to the corresponding path segment (e.g. pattern `/users/:id` + path
  `/users/42` -> `{ id: "42" }`). A pattern with no `:name` segments yields `{}`.
- `src/router.js` — `createRouter()` returns `{ register, resolve }`. `register(pattern, handler)` records a
  route. `resolve(path)` returns `{ handler, params }` for the BEST matching route, or `{ status: 404 }` when no
  route matches. Precedence:
  1. A STATIC route (no `:name` segments) that matches beats any DYNAMIC route that also matches the same path.
  2. Among matches of the same kind, the FIRST registered wins.
  3. A trailing slash on the path is ignored, so `/users/` resolves like `/users`.

No dependencies; keep the CommonJS exports.
