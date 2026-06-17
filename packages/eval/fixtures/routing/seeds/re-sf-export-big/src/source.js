'use strict';

// Backing data source for the export.
//
// fetchAll() is what forces the whole dataset into memory at once. The driver
// also exposes a row-at-a-time cursor (stream), which is currently unused —
// note the two are mutually exclusive contracts: a streaming export can't also
// hand the caller a fully-materialized array.
function makeSource(db) {
  return {
    // Materializes every matching row.
    async fetchAll() {
      return db.query('SELECT id, name, amount FROM report_rows ORDER BY id');
    },
    // Async iterator over the same query, one row at a time.
    stream() {
      return db.cursor('SELECT id, name, amount FROM report_rows ORDER BY id');
    },
  };
}

module.exports = { makeSource };
