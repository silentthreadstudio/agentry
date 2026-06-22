// HIDDEN held-out oracle — the agent NEVER sees this (it lives in oracle/, injected post-run by the harness).
// It requires the agent's BUILT src/slugify.js (one dir up from the injected oracle/) and asserts the slug
// contract objectively. node:test prints the `# pass / # fail / # tests` TAP summary the oracle parser reads.

const test = require("node:test");
const assert = require("node:assert/strict");

const { slugify } = require("../src/slugify.js");

test("lowercases and hyphenates a simple title", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("trims whitespace and collapses punctuation runs to a single hyphen", () => {
  assert.equal(slugify("  Hello, World!  "), "hello-world");
});

test("collapses mixed punctuation + whitespace runs", () => {
  assert.equal(slugify("Node.js  &  TS"), "node-js-ts");
});

test("strips leading and trailing hyphens", () => {
  assert.equal(slugify("!!!edge!!!"), "edge");
});

test("keeps internal digits", () => {
  assert.equal(slugify("Top 10 Tips"), "top-10-tips");
});
