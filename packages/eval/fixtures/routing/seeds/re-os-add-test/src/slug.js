'use strict';

// Pure function: turn a human-readable string into a URL-safe slug.
// Lowercases, trims, and replaces runs of whitespace with single hyphens.
//   slugify('Hello World')  -> 'hello-world'
//   slugify('  Foo   Bar ') -> 'foo-bar'
function slugify(s) {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

module.exports = { slugify };
