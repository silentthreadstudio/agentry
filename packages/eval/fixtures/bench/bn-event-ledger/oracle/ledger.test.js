// HIDDEN held-out oracle — drives all five seams: event validation, the pure reducer, replay, snapshot round-trip,
// and the composing ledger. The DISCRIMINATOR is the snapshot-then-append-then-read probe: a correct ledger resumes
// from the snapshot baseline plus ONLY the events appended after it, so reads stay correct across a snapshot; the
// double-counting broken build re-folds the pre-snapshot events and reads a wrong balance. The stub seed FAILS
// (throws); golden PASSES; broken FAILS the snapshot probe.
const test = require("node:test");
const assert = require("node:assert/strict");

const { deposit, withdraw, transfer } = require("../src/events.js");
const { apply } = require("../src/reducer.js");
const { replay } = require("../src/projection.js");
const { snapshot, restore } = require("../src/snapshot.js");
const { createLedger } = require("../src/index.js");

test("event constructors validate amount and transfer accounts", () => {
  assert.deepEqual(deposit("a", 500), { type: "deposit", account: "a", amount: 500 });
  assert.deepEqual(withdraw("a", 200), { type: "withdraw", account: "a", amount: 200 });
  assert.deepEqual(transfer("a", "b", 100), { type: "transfer", from: "a", to: "b", amount: 100 });
  assert.throws(() => deposit("a", 0), /positive integer/);
  assert.throws(() => deposit("a", -5), /positive integer/);
  assert.throws(() => deposit("a", 1.5), /positive integer/);
  assert.throws(() => transfer("a", "a", 100), /differ/);
});

test("the purity probe: apply does NOT mutate its input state", () => {
  const before = { balances: { a: 100 } };
  const after = apply(before, deposit("a", 50));
  assert.deepEqual(before, { balances: { a: 100 } }, "the input state must be unchanged (pure reducer)");
  assert.deepEqual(after, { balances: { a: 150 } });
  assert.notEqual(after, before, "a new state is returned");
  assert.notEqual(after.balances, before.balances, "a new balances map is returned");
});

test("apply folds deposit, withdraw, and transfer (missing account = 0)", () => {
  assert.deepEqual(apply({ balances: {} }, deposit("x", 25)), { balances: { x: 25 } });
  assert.deepEqual(apply({ balances: { x: 25 } }, withdraw("x", 10)), { balances: { x: 15 } });
  assert.deepEqual(
    apply({ balances: { a: 100 } }, transfer("a", "b", 30)),
    { balances: { a: 70, b: 30 } },
  );
});

test("replay folds an event list from an initial state (nullish = empty)", () => {
  const events = [deposit("a", 500), deposit("b", 200), transfer("a", "b", 150)];
  assert.deepEqual(replay(null, events), { balances: { a: 350, b: 350 } });
  assert.deepEqual(replay({ balances: { a: 1000 } }, [withdraw("a", 100)]), { balances: { a: 900 } });
  assert.deepEqual(replay(undefined, []), { balances: {} });
});

test("snapshot round-trip deep-equals the state and shares no mutable references", () => {
  const state = { balances: { a: 100, b: 200 } };
  const snap = snapshot(state);
  const restored = restore(snap);
  assert.deepEqual(restored, state, "a round-trip must deep-equal the state");
  assert.notEqual(restored.balances, state.balances, "restore must not share the balances map");
  // Mutating the restored state must not leak back into the original.
  restored.balances.a = 999;
  assert.equal(state.balances.a, 100, "the original state must be isolated from the restored copy");
});

test("the ledger replays from empty when no snapshot has been taken", () => {
  const ledger = createLedger();
  ledger.append(deposit("a", 500));
  ledger.append(withdraw("a", 150));
  ledger.append(transfer("a", "b", 100));
  assert.equal(ledger.balanceOf("a"), 250);
  assert.equal(ledger.balanceOf("b"), 100);
  assert.equal(ledger.balanceOf("nobody"), 0);
  assert.equal(ledger.eventCount(), 3);
});

test("the snapshot probe: a read after snapshot-then-append resumes from the snapshot WITHOUT re-folding pre-snapshot events", () => {
  const ledger = createLedger();
  ledger.append(deposit("a", 500));
  ledger.append(deposit("b", 300));
  ledger.snapshotNow(); // baseline: { a: 500, b: 300 } — pre-snapshot events are now folded in exactly once

  // Reading immediately after the snapshot must still see exactly the snapshot state — not double-counted.
  assert.equal(ledger.balanceOf("a"), 500, "post-snapshot read must NOT re-fold the pre-snapshot events (no double-count)");
  assert.equal(ledger.balanceOf("b"), 300);

  // Events appended AFTER the snapshot must layer on top of it exactly once (no stale read).
  ledger.append(withdraw("a", 200));
  ledger.append(transfer("b", "a", 100));
  assert.equal(ledger.balanceOf("a"), 400, "post-snapshot events must apply on top of the snapshot exactly once");
  assert.equal(ledger.balanceOf("b"), 200);
  assert.equal(ledger.eventCount(), 4);
});

test("a second snapshot rebaselines correctly and reads stay exact", () => {
  const ledger = createLedger();
  ledger.append(deposit("a", 100));
  ledger.snapshotNow(); // baseline { a: 100 }
  ledger.append(deposit("a", 50));
  ledger.snapshotNow(); // baseline { a: 150 }
  ledger.append(deposit("a", 25));
  assert.equal(ledger.balanceOf("a"), 175, "each snapshot rebaselines; events are never folded more than once");
});
