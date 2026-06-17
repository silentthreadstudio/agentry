'use strict';

// Thin DB stub. Pretend this is a real pool.
async function query(sql, params) {
  void sql;
  void params;
  return [];
}

module.exports = { query };
