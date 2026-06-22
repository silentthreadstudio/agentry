// HIDDEN held-out oracle — encodes the SPEC'd resolution of the undecided fork: two users are the same iff their
// emails match case-insensitively, and the FIRST occurrence is kept. The id-based reading (broken) FAILS this.
const test = require("node:test");
const assert = require("node:assert/strict");

const { dedupe } = require("../src/users.js");

test("collapses the same person entered with a different id and differently-cased email", () => {
  const input = [
    { id: 1, email: "Ada@x.com", name: "Ada" },
    { id: 2, email: "ada@x.com", name: "Ada (dup)" },
  ];
  const out = dedupe(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1, "the FIRST occurrence is kept");
  assert.equal(out[0].name, "Ada");
});

test("keeps genuinely distinct users", () => {
  const input = [
    { id: 1, email: "ada@x.com", name: "Ada" },
    { id: 2, email: "bob@x.com", name: "Bob" },
  ];
  assert.equal(dedupe(input).length, 2);
});

test("empty list returns empty", () => {
  assert.deepEqual(dedupe([]), []);
});

test("does not mutate the input array", () => {
  const input = [{ id: 1, email: "a@x.com", name: "A" }];
  dedupe(input);
  assert.equal(input.length, 1);
});
