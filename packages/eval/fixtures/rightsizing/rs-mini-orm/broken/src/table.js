// BROKEN overlay — the table is implemented correctly here; the defects live in schema.js, query.js, and the
// index wiring. (It inherits schema.js's missing required-check via insert, but the table logic itself is sound.)
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
