// GOLDEN overlay — pure pagination: 1-based page, ceil(total/size) pages (0 when empty), correct slice + flags.
function paginate(items, opts) {
  const { page, size } = opts;
  const total = items.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / size);
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
