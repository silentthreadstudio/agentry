// GOLDEN overlay — PURE select: filter by equality `where`, sort by `orderBy`, cap by `limit`; any opt may be
// absent. Does not mutate the input rows. seed+golden PASSES the oracle.
function select(rows, opts = {}) {
  let result = [...rows];

  if (opts.where) {
    const entries = Object.entries(opts.where);
    result = result.filter((row) => entries.every(([key, val]) => row[key] === val));
  }

  if (opts.orderBy) {
    const { column, dir } = opts.orderBy;
    const sign = dir === "desc" ? -1 : 1;
    result.sort((a, b) => {
      if (a[column] < b[column]) return -1 * sign;
      if (a[column] > b[column]) return 1 * sign;
      return 0;
    });
  }

  if (opts.limit !== undefined) {
    result = result.slice(0, opts.limit);
  }

  return result;
}

module.exports = { select };
