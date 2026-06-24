// GOLDEN overlay — adds the correct `slugify`, leaves `truncate` intact. seed+golden PASSES the oracle.
function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n);
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = { truncate, slugify };
