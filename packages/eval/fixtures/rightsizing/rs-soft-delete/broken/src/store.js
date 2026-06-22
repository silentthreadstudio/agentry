// BROKEN overlay — a substantially INCOMPLETE soft delete: `remove` sets `deletedAt`, but NOTHING reads it
// correctly — `get` AND `list` both still return soft-deleted records, and `restore` was never added at all. Only
// the write side was touched; every reader and the restore path are missing. seed+broken FAILS the oracle on
// multiple assertions (get-excludes, list-excludes, and restore) — a half-finished deliverable.
function createStore(opts) {
  const records = new Map();

  return {
    add(item) {
      records.set(item.id, { ...item });
      return item.id;
    },
    get(id) {
      return records.get(id); // BUG: does not exclude soft-deleted records.
    },
    list() {
      return [...records.values()]; // BUG: does not exclude soft-deleted records.
    },
    remove(id) {
      const rec = records.get(id);
      if (rec) rec.deletedAt = opts.now();
    },
    // BUG: `restore(id)` is missing entirely — a soft-deleted record can never be brought back.
  };
}

module.exports = { createStore };
