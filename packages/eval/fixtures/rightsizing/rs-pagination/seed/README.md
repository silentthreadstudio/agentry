# paginator

Build a paginator across three files with clean seams:
- `src/meta.js` — `pageCount(total, perPage)` (round UP for a partial last page).
- `src/slice.js` — `pageSlice(items, perPage, page)` (1-based; out-of-range → empty slice).
- `src/index.js` — `paginate(items, perPage, page)` returning `{ page, perPage, pageCount, total, items }`,
  composing the two helpers.

The seed ships the stub signatures; fill them in. Keep CommonJS exports. No dependencies.
