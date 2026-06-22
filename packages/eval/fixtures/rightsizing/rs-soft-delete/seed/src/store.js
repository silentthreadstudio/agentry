// In-memory record store. `remove` is a HARD delete today — change it to SOFT delete (see README), update the
// readers to exclude soft-deleted records, and add `restore`. `opts.now()` is the injected clock for `deletedAt`.
function createStore(opts) {
  const records = new Map();

  return {
    add(item) {
      records.set(item.id, { ...item });
      return item.id;
    },
    get(id) {
      return records.get(id);
    },
    list() {
      return [...records.values()];
    },
    remove(id) {
      // HARD delete today — to become a soft delete.
      records.delete(id);
    },
  };
}

module.exports = { createStore };
