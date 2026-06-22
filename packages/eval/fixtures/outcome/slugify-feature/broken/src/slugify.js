// BROKEN overlay — a planted-WRONG slugify. seed+broken FAILS the held-out oracle (the discrimination control).
// The bug: it lowercases but never collapses punctuation/whitespace to hyphens or trims — so "Hello World"
// stays "hello world", failing every hyphenation assertion.
function slugify(title) {
  return String(title).toLowerCase();
}

module.exports = { slugify };
