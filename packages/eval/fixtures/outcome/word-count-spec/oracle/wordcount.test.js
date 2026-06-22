// HIDDEN held-out oracle — the agent NEVER sees this. It pins only the UNAMBIGUOUS core of the under-specified
// goal: whitespace-delimited tokens, collapsed runs, leading/trailing trimmed, empty/whitespace-only ⇒ 0.

const test = require("node:test");
const assert = require("node:assert/strict");

const { wordCount } = require("../src/wordcount.js");

test("counts simple space-separated words", () => {
  assert.equal(wordCount("hello world"), 2);
});

test("collapses runs of whitespace between words", () => {
  assert.equal(wordCount("hello   world"), 2);
});

test("treats tabs and newlines as separators", () => {
  assert.equal(wordCount("  one\ttwo\nthree  "), 3);
});

test("ignores leading and trailing whitespace", () => {
  assert.equal(wordCount("  solo  "), 1);
});

test("an empty string has zero words", () => {
  assert.equal(wordCount(""), 0);
});

test("a whitespace-only string has zero words", () => {
  assert.equal(wordCount("   "), 0);
});
