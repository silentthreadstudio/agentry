// HIDDEN held-out oracle — probes the two subtle CSV traps the bare split(",") gets wrong: a comma INSIDE a quoted
// field, and a preserved trailing empty field.
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseLine } = require("../src/csv.js");

test("splits plain comma-separated fields", () => {
  assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
});

test("the subtle-bug probe: a comma INSIDE a quoted field is not a separator", () => {
  assert.deepEqual(parseLine('a,"b,c",d'), ["a", "b,c", "d"]);
});

test("a doubled quote inside a quoted field is a literal quote", () => {
  assert.deepEqual(parseLine('"she said ""hi"""'), ['she said "hi"']);
});

test("a trailing comma preserves the final empty field", () => {
  assert.deepEqual(parseLine("a,b,"), ["a", "b", ""]);
});

test("an empty line is a single empty field", () => {
  assert.deepEqual(parseLine(""), [""]);
});
