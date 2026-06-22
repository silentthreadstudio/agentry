// BROKEN overlay — the facade wires tables and relations, but remove inherits the relations layer's broken
// canRemove (always true), so RESTRICT is never enforced: a referenced row is deleted instead of throwing.
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
      // BUG: canRemove is broken (always true), so this never throws on a referenced row — RESTRICT is not
      // enforced and the parent is deleted out from under its children.
      if (!relations.canRemove(tableName, id, db)) {
        throw new Error(`cannot remove ${tableName}#${id}: still referenced`);
      }
      tables.get(tableName).remove(id);
    },
  };

  return db;
}

module.exports = { createDb };
