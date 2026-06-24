// BROKEN overlay — the paginator uses FLOOR instead of CEIL for totalPages, so a trailing partial page is dropped:
// 5 items at size 2 reports 2 total pages (should be 3) and hasNext is wrong on the last full page. seed+broken
// FAILS the oracle's totalPages / hasNext assertions.
function paginate(items, opts) {
  const { page, size } = opts;
  const total = items.length;
  const totalPages = Math.floor(total / size); // BUG: floor drops the trailing partial page; should be ceil.
  const start = (page - 1) * size;
  return {
    items: items.slice(start, start + size),
    page,
    size,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

module.exports = { paginate };
