// GOLDEN overlay — schema-validated insert (THROWS on invalid) with an auto-incrementing integer id starting at 1.
// seed+golden PASSES the oracle.
function createTable(schema) {
  const rows = new Map();
  let nextId = 1;

  return {
    insert(row) {
      const result = schema.validate(row);
      if (!result.ok) {
        throw new Error(`invalid row: ${result.errors.join("; ")}`);
      }
      const id = nextId++;
      const stored = { ...result.value, id };
      rows.set(id, stored);
      return stored;
    },
    get(id) {
      return rows.get(id);
    },
    all() {
      return [...rows.values()];
    },
    remove(id) {
      rows.delete(id);
    },
  };
}

module.exports = { createTable };
