// GOLDEN overlay — correct page math (ceil for a partial last page). seed+golden PASSES the oracle.
function pageCount(total, perPage) {
  if (perPage <= 0) return 0;
  return Math.ceil(total / perPage);
}

module.exports = { pageCount };
