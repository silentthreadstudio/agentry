// HIDDEN held-out oracle — drives the store, the pure paginator, and the composition. The stub seed FAILS (throws);
// golden PASSES; the floor-instead-of-ceil broken paginator FAILS the totalPages / hasNext assertions on a list
// whose size does not divide evenly.
const test = require("node:test");
const assert = require("node:assert/strict");

const { createStore } = require("../src/store.js");
const { paginate } = require("../src/page.js");
const { listPage } = require("../src/index.js");

function storeOf(n) {
  const s = createStore();
  for (let i = 1; i <= n; i++) s.add({ id: i });
  return s;
}

test("paginates a full page and reports the flags", () => {
  const page = listPage(storeOf(5), { page: 1, size: 2 });
  assert.deepEqual(page.items.map((r) => r.id), [1, 2]);
  assert.equal(page.total, 5);
  assert.equal(page.page, 1);
  assert.equal(page.hasPrev, false);
  assert.equal(page.hasNext, true);
});

test("the trailing partial page is reachable (ceil, not floor, totalPages)", () => {
  const page = listPage(storeOf(5), { page: 3, size: 2 });
  assert.equal(page.totalPages, 3, "5 items at size 2 = 3 pages — the partial last page counts");
  assert.deepEqual(page.items.map((r) => r.id), [5]);
  assert.equal(page.hasNext, false);
  assert.equal(page.hasPrev, true);
});

test("hasNext is true on the last FULL page when a partial page follows", () => {
  const page = paginate([1, 2, 3, 4, 5], { page: 2, size: 2 });
  assert.equal(page.hasNext, true, "page 2 of 3 still has a next page");
});

test("an empty store yields zero pages", () => {
  const page = listPage(createStore(), { page: 1, size: 10 });
  assert.equal(page.total, 0);
  assert.equal(page.totalPages, 0);
  assert.deepEqual(page.items, []);
  assert.equal(page.hasNext, false);
});

test("an evenly divisible total has no trailing partial page", () => {
  const page = paginate([1, 2, 3, 4], { page: 2, size: 2 });
  assert.equal(page.totalPages, 2);
  assert.equal(page.hasNext, false);
});
