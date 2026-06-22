// GOLDEN overlay — a known-correct slugify. seed+golden PASSES the held-out oracle (the discrimination control).
function slugify(title) {
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = { slugify };
