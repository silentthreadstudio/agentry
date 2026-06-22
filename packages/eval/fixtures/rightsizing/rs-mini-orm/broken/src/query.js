// BROKEN overlay — select filters by `where` and caps by `limit`, but IGNORES `orderBy` entirely, so results
// come back in insertion order regardless of the requested sort. seed+broken FAILS the oracle.
function select(rows, opts = {}) {
  let result = [...rows];

  if (opts.where) {
    const entries = Object.entries(opts.where);
    result = result.filter((row) => entries.every(([key, val]) => row[key] === val));
  }

  // BUG: opts.orderBy is never applied — the rows are not sorted, so a "desc" query returns ascending/insertion
  // order. The sort step is missing entirely.

  if (opts.limit !== undefined) {
    result = result.slice(0, opts.limit);
  }

  return result;
}

module.exports = { select };
