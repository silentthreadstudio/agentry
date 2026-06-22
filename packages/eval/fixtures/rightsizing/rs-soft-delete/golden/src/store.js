// GOLDEN overlay — soft delete: remove marks `deletedAt`; get/list exclude soft-deleted; restore un-deletes.
// seed+golden PASSES the oracle.
function createStore(opts) {
  const records = new Map();

  const isLive = (rec) => rec !== undefined && rec.deletedAt === undefined;

  return {
    add(item) {
      records.set(item.id, { ...item });
      return item.id;
    },
    get(id) {
      const rec = records.get(id);
      return isLive(rec) ? rec : undefined;
    },
    list() {
      return [...records.values()].filter(isLive);
    },
    remove(id) {
      const rec = records.get(id);
      if (rec) rec.deletedAt = opts.now();
    },
    restore(id) {
      const rec = records.get(id);
      if (rec) delete rec.deletedAt;
    },
  };
}

module.exports = { createStore };
