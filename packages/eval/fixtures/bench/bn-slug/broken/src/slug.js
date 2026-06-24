// BROKEN overlay — `slugify` lowercases and swaps non-alphanumerics for hyphens but never TRIMS the leading/
// trailing hyphens, so "  Hello, World!  " → "-hello-world-". seed+broken FAILS the oracle's trim assertion.
function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n);
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-"); // BUG: never trims leading/trailing hyphens.
}

module.exports = { truncate, slugify };
