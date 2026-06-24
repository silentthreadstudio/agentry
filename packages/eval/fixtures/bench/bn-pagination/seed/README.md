# pagination

A paginated record store across three files with clean seams:
- `src/store.js` — `createStore()` → `{ add(record), all() }`, insertion-ordered in-memory list.
- `src/page.js` — PURE `paginate(items, { page, size })` → `{ items, page, size, total, totalPages, hasNext, hasPrev }`
  (1-based `page`, `totalPages = ceil(total/size)`, 0 when empty).
- `src/index.js` — `listPage(store, opts)` paginates `store.all()`.

The seed ships stub signatures; fill them in. Keep CommonJS exports. No dependencies.
