# store

An in-memory record store: `createStore(opts)` → `{ add, get, list, remove }`. Today `remove(id)` HARD-deletes.

Change it to SOFT delete: `remove(id)` marks `deletedAt` (using `opts.now()`); `get`/`list` exclude soft-deleted
records; add `restore(id)` to un-delete. Keep the signatures + CommonJS export. No dependencies.
