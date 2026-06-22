// GOLDEN overlay — correct 1-based slicing; out-of-range page → empty slice.
function pageSlice(items, perPage, page) {
  const start = (page - 1) * perPage;
  if (start < 0 || start >= items.length) return [];
  return items.slice(start, start + perPage);
}

module.exports = { pageSlice };
