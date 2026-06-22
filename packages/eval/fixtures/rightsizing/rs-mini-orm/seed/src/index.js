// Db facade component. STUB — wire schema + table + query + relations into `createDb`. See README.
const { defineSchema } = require("./schema.js");
const { createTable } = require("./table.js");
const { createRelations } = require("./relations.js");

function createDb() {
  throw new Error("not implemented");
}

module.exports = { createDb };
