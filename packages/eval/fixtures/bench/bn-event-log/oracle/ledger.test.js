// HIDDEN held-out oracle — drives the ledger, the reducer, and the replay. The stub seed FAILS (throws); golden
// PASSES; the mutating broken reducer FAILS the no-mutation purity probe.
const test = require("node:test");
const assert = require("node:assert/strict");

const { createLedger } = require("../src/ledger.js");
const { applyEntry } = require("../src/reducer.js");
const { balances } = require("../src/index.js");

test("replays credits and debits into per-account balances", () => {
  const ledger = createLedger();
  ledger.post({ account: "a", amount: 500 });
  ledger.post({ account: "b", amount: 200 });
  ledger.post({ account: "a", amount: -150 });
  assert.deepEqual(balances(ledger), { a: 350, b: 200 });
});

test("the purity probe: applyEntry does NOT mutate its input balances", () => {
  const before = { a: 100 };
  const after = applyEntry(before, { account: "a", amount: 50 });
  assert.deepEqual(before, { a: 100 }, "the input balances must be unchanged (pure reducer)");
  assert.deepEqual(after, { a: 150 });
  assert.notEqual(after, before, "a new object is returned");
});

test("a missing account starts from 0", () => {
  assert.deepEqual(applyEntry({}, { account: "x", amount: 25 }), { x: 25 });
});

test("an empty ledger replays to an empty balance map", () => {
  assert.deepEqual(balances(createLedger()), {});
});
