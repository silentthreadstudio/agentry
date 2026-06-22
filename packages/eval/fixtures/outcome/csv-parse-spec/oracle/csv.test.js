// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It requires the agent's BUILT
// src/csv.js and asserts the quote-aware contract: plain rows (happy path) AND the quoting TRAP cases.

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseLine } = require("../src/csv.js");

// --- happy path ---
test("splits a plain three-field row", () => {
  assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
});

test("trims surrounding whitespace on each field", () => {
  assert.deepEqual(parseLine("a, b ,c"), ["a", "b", "c"]);
});

test("a single field with no commas is one element", () => {
  assert.deepEqual(parseLine("one"), ["one"]);
});

test("an empty line is one empty field", () => {
  assert.deepEqual(parseLine(""), [""]);
});

// --- TRAP: a comma INSIDE a quoted field is not a separator ---
test('a quoted field containing a comma stays one field', () => {
  assert.deepEqual(parseLine('a,"b,c",d'), ["a", "b,c", "d"]);
});

// --- TRAP: a doubled quote inside a quoted field is a literal quote ---
test('escaped "" inside a quoted field becomes one literal quote', () => {
  assert.deepEqual(parseLine('"he said ""hi"""'), ['he said "hi"']);
});

// --- TRAP: both at once across multiple fields ---
test("quoted commas and escaped quotes combine correctly", () => {
  assert.deepEqual(parseLine('x,"y, z","w""q"'), ["x", "y, z", 'w"q']);
});
