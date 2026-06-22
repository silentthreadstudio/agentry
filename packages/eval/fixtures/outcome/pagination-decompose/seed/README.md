# pagination

A tiny CommonJS pagination library, exposed from `src/index.js`, split across:

- `src/meta.js` — `pageCount(total, perPage)`: how many pages a list of `total` items needs.
- `src/paginate.js` — `pageInfo(total, perPage, page)` → `{ page, pageCount, isLast }`.
- `src/index.js` — re-exports both.

There is a bug: `pageCount` uses `Math.floor`, so a list that does not divide evenly drops its final partial page
(`pageCount(10, 3)` returns `3`, should be `4`). That wrong count also breaks `pageInfo`'s `isLast`. Fix
`pageCount` to round up. Keep the CommonJS exports across all three files; no dependencies.
