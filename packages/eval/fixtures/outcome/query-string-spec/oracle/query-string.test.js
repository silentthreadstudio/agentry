// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It requires the agent's BUILT
// src/query-string.js and asserts the parse contract: the happy path AND the three TRAP cases a naive
// split-and-assign misses — repeated keys (array), empty/missing values (""), and URL-decoding (incl. `+`).

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseQuery } = require("../src/query-string.js");

// --- happy path ---
test("parses a single key=value into a string", () => {
  assert.deepEqual(parseQuery("a=1"), { a: "1" });
});

test("parses multiple distinct keys", () => {
  assert.deepEqual(parseQuery("a=1&b=2"), { a: "1", b: "2" });
});

test("empty input returns an empty object", () => {
  assert.deepEqual(parseQuery(""), {});
});

// --- TRAP: repeated keys collect into an array, in order (naive last-write-wins overwrites them) ---
test("a repeated key collects its values into an array in order", () => {
  assert.deepEqual(parseQuery("a=1&a=2"), { a: ["1", "2"] });
});

test("three occurrences of a key produce a three-element array", () => {
  assert.deepEqual(parseQuery("x=1&x=2&x=3"), { x: ["1", "2", "3"] });
});

// --- TRAP: empty or missing value maps to "" (not undefined, not dropped) ---
test("a key with an empty value maps to the empty string", () => {
  assert.deepEqual(parseQuery("b="), { b: "" });
});

test("a bare key with no '=' maps to the empty string", () => {
  assert.deepEqual(parseQuery("c"), { c: "" });
});

// --- TRAP: URL-decoding of keys and values, including `+` -> space ---
test("decodes %20 in a value to a space", () => {
  assert.deepEqual(parseQuery("a=%20"), { a: " " });
});

test("decodes %26 (an encoded ampersand) inside a value", () => {
  assert.deepEqual(parseQuery("a=x%26y"), { a: "x&y" });
});

test("decodes + to a space in both key and value", () => {
  assert.deepEqual(parseQuery("a+b=c+d"), { "a b": "c d" });
});

// --- the canonical mixed example from the prompt ---
test("the mixed example: repeat + empty value", () => {
  assert.deepEqual(parseQuery("a=1&a=2&b="), { a: ["1", "2"], b: "" });
});
