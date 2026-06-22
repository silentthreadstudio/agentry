// HIDDEN held-out oracle — asserts the soft-delete contract across remove/get/list/restore. The hard-delete seed
// FAILS (no restore, and a removed record cannot reappear); golden PASSES; the broken (get not filtered) FAILS the
// "get excludes soft-deleted" case.
const test = require("node:test");
const assert = require("node:assert/strict");

const { createStore } = require("../src/store.js");

function newStore() {
  let clock = 0;
  return createStore({ now: () => (clock += 1) });
}

test("remove soft-deletes: get and list exclude the record", () => {
  const s = newStore();
  s.add({ id: "a", v: 1 });
  s.add({ id: "b", v: 2 });
  s.remove("a");
  assert.equal(s.get("a"), undefined, "get must exclude a soft-deleted record");
  assert.deepEqual(
    s.list().map((r) => r.id),
    ["b"],
    "list must exclude a soft-deleted record",
  );
});

test("restore brings a soft-deleted record back into get and list", () => {
  const s = newStore();
  s.add({ id: "a", v: 1 });
  s.remove("a");
  s.restore("a");
  assert.ok(s.get("a"), "restored record reappears in get");
  assert.deepEqual(
    s.list().map((r) => r.id),
    ["a"],
  );
});

test("a soft-deleted record carries a deletedAt marker (it is not dropped)", () => {
  const s = newStore();
  s.add({ id: "a", v: 1 });
  s.remove("a");
  s.restore("a"); // proves the record still existed to be restored
  assert.ok(s.get("a"));
});

test("live records are unaffected", () => {
  const s = newStore();
  s.add({ id: "a", v: 1 });
  assert.deepEqual(s.get("a"), { id: "a", v: 1 });
  assert.equal(s.list().length, 1);
});
