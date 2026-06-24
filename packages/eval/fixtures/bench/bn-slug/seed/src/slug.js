// String helpers. `slugify` is to be ADDED; `truncate` already exists and must not change.
function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n);
}

module.exports = { truncate };
