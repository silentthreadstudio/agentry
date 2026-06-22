// HIDDEN held-out oracle — drives the public `paginate` and the two components. The stub seed FAILS (throws);
// golden PASSES; the floored-pageCount broken FAILS the partial-last-page assertion.
const test = require("node:test");
const assert = require("node:assert/strict");

const { paginate } = require("../src/index.js");
const { pageCount } = require("../src/meta.js");
const { pageSlice } = require("../src/slice.js");

test("page 1 returns the first slice with the full envelope", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 2, 1), {
    page: 1,
    perPage: 2,
    pageCount: 3,
    total: 5,
    items: [1, 2],
  });
});

test("the final partial page is included (ceil, not floor)", () => {
  const r = paginate([1, 2, 3, 4, 5], 2, 3);
  assert.equal(r.pageCount, 3);
  assert.deepEqual(r.items, [5]);
});

test("pageCount rounds up for a partial last page", () => {
  assert.equal(pageCount(10, 3), 4);
  assert.equal(pageCount(6, 3), 2);
});

test("an out-of-range page yields an empty slice", () => {
  assert.deepEqual(pageSlice([1, 2, 3], 2, 9), []);
});
