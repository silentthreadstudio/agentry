// HIDDEN held-out oracle — drives the store, the worker's retry/dead-letter policy, and the index wiring. The
// stub seed FAILS (throws "not implemented"); golden PASSES; the no-retry/wrong-stats broken FAILS.
const test = require("node:test");
const assert = require("node:assert/strict");

const { createStore } = require("../src/store.js");
const { createWorker } = require("../src/worker.js");
const { createQueue } = require("../src/index.js");

test("store is FIFO and dequeue returns undefined when empty", () => {
  const store = createStore();
  assert.equal(store.dequeue(), undefined);
  store.enqueue("a");
  store.enqueue("b");
  assert.equal(store.size(), 2);
  assert.equal(store.dequeue(), "a");
  assert.equal(store.dequeue(), "b");
  assert.equal(store.dequeue(), undefined);
});

test("drain processes every queued job in FIFO order", () => {
  const store = createStore();
  for (const n of [1, 2, 3, 4]) store.enqueue(n);
  const seen = [];
  const worker = createWorker(store, (job) => seen.push(job));
  const result = worker.drain();
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.equal(result.processed, 4);
  assert.equal(result.deadLettered, 0);
  assert.equal(store.size(), 0);
});

test("a handler that throws twice then succeeds IS processed (3-attempt retry)", () => {
  const store = createStore();
  store.enqueue("flaky");
  let attempts = 0;
  const worker = createWorker(store, () => {
    attempts++;
    if (attempts < 3) throw new Error("transient");
  });
  const result = worker.drain();
  assert.equal(attempts, 3); // failed twice, succeeded on the 3rd attempt
  assert.equal(result.processed, 1);
  assert.equal(result.deadLettered, 0);
});

test("a handler that always throws is DEAD-LETTERED after exactly 3 attempts, not processed", () => {
  const store = createStore();
  store.enqueue("poison");
  let attempts = 0;
  const worker = createWorker(store, () => {
    attempts++;
    throw new Error("always fails");
  });
  const result = worker.drain();
  assert.equal(attempts, 3); // tried exactly 3 times, no more
  assert.equal(result.processed, 0);
  assert.equal(result.deadLettered, 1); // set aside, counted, not lost
});

test("stats() reflects processed, deadLettered, and pending correctly", () => {
  // One job will succeed, one will always throw (dead-letter); a third is submitted but left undrained.
  const queue = createQueue((job) => {
    if (job === "bad") throw new Error("boom");
    // "good" succeeds
  });
  queue.submit("good");
  queue.submit("bad");
  queue.drain();
  queue.submit("later"); // still pending — not drained
  const stats = queue.stats();
  assert.equal(stats.processed, 1);
  assert.equal(stats.deadLettered, 1);
  assert.equal(stats.pending, 1); // one job still in the store
});
