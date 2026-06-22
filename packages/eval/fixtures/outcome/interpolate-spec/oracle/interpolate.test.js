// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It requires the agent's BUILT
// src/interpolate.js and asserts the interpolation contract: the happy path AND the two TRAP cases a naive global
// replace misses — a MISSING key must leave the literal placeholder (never "undefined"), and `{{`/`}}` must
// escape to literal braces (never be treated as placeholder delimiters).

const test = require("node:test");
const assert = require("node:assert/strict");

const { interpolate } = require("../src/interpolate.js");

// --- happy path ---
test("replaces a present placeholder", () => {
  assert.equal(interpolate("Hi {name}", { name: "Ada" }), "Hi Ada");
});

test("replaces multiple placeholders", () => {
  assert.equal(interpolate("{a}-{b}", { a: "1", b: "2" }), "1-2");
});

test("stringifies non-string values", () => {
  assert.equal(interpolate("n={n}", { n: 42 }), "n=42");
});

test("a template with no placeholders is returned unchanged", () => {
  assert.equal(interpolate("plain text", {}), "plain text");
});

// --- TRAP: a missing key leaves the literal placeholder, NOT "undefined" ---
test("a missing key leaves the literal placeholder", () => {
  assert.equal(interpolate("Hi {name}", {}), "Hi {name}");
});

test("a missing key among present ones leaves only that placeholder literal", () => {
  assert.equal(interpolate("{a} {b}", { a: "X" }), "X {b}");
});

test("never emits the string 'undefined' for a missing key", () => {
  assert.ok(!interpolate("{missing}", {}).includes("undefined"));
});

// --- TRAP: {{ }} escape to literal braces and are never interpolated ---
test("{{ and }} escape to literal single braces", () => {
  assert.equal(interpolate("{{not a var}}", {}), "{not a var}");
});

test("an escaped brace is not treated as a placeholder delimiter", () => {
  // The escaped `{{name}}` must NOT pull from values — it is a literal `{name}`.
  assert.equal(interpolate("{{name}}", { name: "Ada" }), "{name}");
});

test("escapes and real placeholders coexist", () => {
  assert.equal(interpolate("{{literal}} and {real}", { real: "value" }), "{literal} and value");
});
