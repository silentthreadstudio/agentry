// GOLDEN overlay — the db facade: defines schema-backed tables, registers relations, and enforces RESTRICT on
// remove by consulting relations before deleting. seed+golden PASSES the oracle.
const { defineSchema } = require("./schema.js");
const { createTable } = require("./table.js");
const { createRelations } = require("./relations.js");

function createDb() {
  const tables = new Map();
  const relations = createRelations();

  const db = {
    defineTable(name, columns) {
      const table = createTable(defineSchema(columns));
      tables.set(name, table);
      return table;
    },
    table(name) {
      return tables.get(name);
    },
    link(childTable, column, parentTable) {
      relations.link(childTable, column, parentTable);
    },
    remove(tableName, id) {
      if (!relations.canRemove(tableName, id, db)) {
        throw new Error(`cannot remove ${tableName}#${id}: still referenced`);
      }
      tables.get(tableName).remove(id);
    },
  };

  return db;
}

module.exports = { createDb };
