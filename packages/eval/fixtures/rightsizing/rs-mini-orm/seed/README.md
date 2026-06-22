# mini-orm

Build a tiny in-memory relational store across five files with cross-cutting seams:
- `src/schema.js` — `defineSchema(columns)` → `{ validate(row) }`. `columns` maps name →
  `{ type: "string"|"number"|"boolean", required?: boolean, default?: any }`. `validate(row)` applies defaults for
  missing optional columns, then returns `{ ok, value, errors }` — `ok:false` with an `errors` array if a required
  column is missing or a present column has the wrong type.
- `src/table.js` — `createTable(schema)` → `{ insert(row), get(id), all(), remove(id) }`. `insert` validates via
  the schema (THROWS on invalid), auto-assigns an incrementing integer `id` starting at 1, and stores the
  validated row; `get(id)` returns the row or undefined; `all()` returns every row; `remove(id)` deletes it.
- `src/query.js` — `select(rows, opts)`, a PURE function. `opts.where` is an equality map (all keys must match),
  `opts.orderBy` is `{ column, dir: "asc"|"desc" }`, `opts.limit` caps the count. Returns the
  filtered+sorted+limited rows; any opt may be absent.
- `src/relations.js` — `createRelations()` → `{ link(childTable, column, parentTable), canRemove(parentTable, parentId, db) }`.
  `link` registers a foreign key; `canRemove` returns false if ANY row in a linked child table references
  `parentId` via its FK column (a referenced parent cannot be removed).
- `src/index.js` — `createDb()` → `{ defineTable(name, columns), table(name), link(childTable, column, parentTable), remove(tableName, id) }`.
  `remove` consults relations and THROWS if the row is still referenced (RESTRICT), otherwise removes it.

The seed ships the stub signatures; fill them in. Keep CommonJS exports. No dependencies.
