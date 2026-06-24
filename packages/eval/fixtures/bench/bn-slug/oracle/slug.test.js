// HIDDEN held-out oracle — asserts the slugify contract AND that the existing truncate still works.
const test = require("node:test");
const assert = require("node:assert/strict");

const slug = require("../src/slug.js");

test("lowercases and hyphenates a title", () => {
  assert.equal(slug.slugify("Hello World"), "hello-world");
});

test("collapses punctuation runs and trims edge hyphens", () => {
  assert.equal(slug.slugify("  Hello, World!  "), "hello-world");
});

test("a run of separators becomes a single hyphen", () => {
  assert.equal(slug.slugify("a___b   c"), "a-b-c");
});

test("the existing truncate is untouched", () => {
  assert.equal(slug.truncate("abcdef", 3), "abc");
});
