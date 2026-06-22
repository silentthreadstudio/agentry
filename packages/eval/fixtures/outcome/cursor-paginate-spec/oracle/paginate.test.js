// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It requires the agent's BUILT
// src/paginate.js and asserts the cursor contract: a mid-list page (happy path) AND the boundary TRAP cases.

const test = require("node:test");
const assert = require("node:assert/strict");

const { paginate } = require("../src/paginate.js");

const ITEMS = [1, 2, 3, 4, 5, 6];

// --- happy path ---
test("first page from a null cursor", () => {
  assert.deepEqual(paginate(ITEMS, null, 2), { page: [1, 2], nextCursor: 2 });
});

test("a mid-list page advances the cursor", () => {
  assert.deepEqual(paginate(ITEMS, 2, 2), { page: [3, 4], nextCursor: 4 });
});

test("preserves original order within a page", () => {
  assert.deepEqual(paginate(["a", "b", "c", "d"], 0, 3).page, ["a", "b", "c"]);
});

// --- TRAP: the exact-multiple last page must report nextCursor: null ---
test("the last full page returns nextCursor null", () => {
  assert.deepEqual(paginate(ITEMS, 4, 2), { page: [5, 6], nextCursor: null });
});

// --- TRAP: a partial last page must also report null ---
test("a partial last page returns nextCursor null", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 4, 2), { page: [5], nextCursor: null });
});

// --- TRAP: a cursor at/past the end yields an empty page and null ---
test("a cursor past the end yields an empty page and null cursor", () => {
  assert.deepEqual(paginate(ITEMS, 6, 2), { page: [], nextCursor: null });
});

// --- TRAP: empty input ---
test("an empty list yields an empty page and null cursor", () => {
  assert.deepEqual(paginate([], null, 3), { page: [], nextCursor: null });
});
