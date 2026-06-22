// GOLDEN overlay — cursor pagination that returns `nextCursor: null` once the list is exhausted, and an empty
// page for a cursor at/past the end. seed+golden PASSES the held-out oracle (the discrimination control).
function paginate(items, cursor, size) {
  const start = cursor == null ? 0 : cursor;
  if (start >= items.length) {
    return { page: [], nextCursor: null };
  }
  const page = items.slice(start, start + size);
  const next = start + size;
  const nextCursor = next < items.length ? next : null;
  return { page, nextCursor };
}

module.exports = { paginate };
