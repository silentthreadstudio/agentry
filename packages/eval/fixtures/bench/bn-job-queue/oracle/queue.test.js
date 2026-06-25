// HIDDEN held-out oracle — the discriminators are the FAIRNESS probe (a failed job retries at the BACK, so other
// queued jobs run before its retry) and the DEAD-LETTER probe (the attempt count survives requeue, so a job that
// keeps failing dead-letters after maxAttempts instead of retrying forever). A true design retries fairly and
// accumulates attempts; the obvious build front-requeues and/or loses the attempt count. Every handler below stops
// failing after a bounded number of calls, so even a buggy (never-dead-lettering) build terminates rather than hangs.
const test = require("node:test");
const assert = require("node:assert/strict");

const { createQueue } = require("../src/index.js");
const { createStore } = require("../src/store.js");
const { createDeadLetter } = require("../src/deadletter.js");
const { delayFor } = require("../src/backoff.js");
const { runOnce } = require("../src/worker.js");

test("store is FIFO: enqueue/dequeue/peek/size", () => {
  const s = createStore();
  assert.equal(s.size(), 0);
  assert.equal(s.dequeue(), undefined);
  s.enqueue("a");
  s.enqueue("b");
  assert.equal(s.size(), 2);
  assert.equal(s.peek(), "a");
  assert.equal(s.dequeue(), "a"); // front comes out first
  assert.equal(s.dequeue(), "b");
  assert.equal(s.size(), 0);
});

test("backoff is a pure capped exponential", () => {
  assert.equal(delayFor(1), 100);
  assert.equal(delayFor(2), 200);
  assert.equal(delayFor(3), 400);
  assert.equal(delayFor(4), 800);
  assert.ok(delayFor(20) <= 5000, "the delay is capped at 5000ms");
  assert.equal(delayFor(2), 200, "pure: same input, same output");
});

test("dead-letter sink: add/list/size", () => {
  const dl = createDeadLetter();
  assert.equal(dl.size(), 0);
  dl.add({ payload: "x" });
  assert.equal(dl.size(), 1);
  assert.equal(dl.list()[0].payload, "x");
});

test("processes every job that succeeds first time", () => {
  const q = createQueue({ maxAttempts: 3 });
  const seen = [];
  q.add("a");
  q.add("b");
  q.add("c");
  q.process((p) => seen.push(p));
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.deepEqual(q.stats(), { pending: 0, deadLettered: 0, processed: 3 });
});

test("worker returns false on an empty store and true when it processed a job", () => {
  const store = createStore();
  const dl = createDeadLetter();
  assert.equal(runOnce(store, dl, () => {}, 3), false);
  store.enqueue({ payload: "a", attempts: 0, status: "pending" });
  assert.equal(runOnce(store, dl, () => {}, 3), true);
});

test("THE FAIRNESS PROBE: a failed job retries at the BACK, so other jobs run before its retry", () => {
  const q = createQueue({ maxAttempts: 3 });
  // "a" fails the first time it is handled, then succeeds; "b" and "c" always succeed.
  let aFailsLeft = 1;
  const order = [];
  const handler = (p) => {
    order.push(p);
    if (p === "a" && aFailsLeft > 0) {
      aFailsLeft -= 1;
      throw new Error("transient");
    }
  };
  q.add("a");
  q.add("b");
  q.add("c");
  q.process(handler);
  // Fair (BACK) retry: a fails, b and c run, THEN a's retry → a, b, c, a.
  // Front-requeue would starve them → a, a, b, c (a retried immediately, before b and c).
  assert.deepEqual(
    order,
    ["a", "b", "c", "a"],
    "the retry of 'a' must run AFTER 'b' and 'c' (fair, back of the queue)",
  );
  assert.deepEqual(q.stats(), { pending: 0, deadLettered: 0, processed: 3 });
});

test("THE DEAD-LETTER PROBE: the attempt count survives requeue, so a persistently-failing job dead-letters after maxAttempts", () => {
  const q = createQueue({ maxAttempts: 3 });
  // Fails the first 5 handler calls, then would succeed. A correct build (attempts preserved) dead-letters after 3
  // attempts and never reaches the 6th call; a build that resets attempts on requeue would keep retrying and only
  // stop once the handler stops failing (call 6) — wrongly counting it as processed instead of dead-lettered.
  let callsUntilSuccess = 5;
  const handler = () => {
    if (callsUntilSuccess > 0) {
      callsUntilSuccess -= 1;
      throw new Error("permanent");
    }
  };
  q.add("doomed");
  q.process(handler);
  const stats = q.stats();
  assert.equal(stats.deadLettered, 1, "after maxAttempts failures the job must be dead-lettered");
  assert.equal(stats.processed, 0, "a dead-lettered job is NOT counted as processed");
  assert.equal(stats.pending, 0, "nothing left pending");
});

test("a job that recovers within maxAttempts is processed, not dead-lettered", () => {
  const q = createQueue({ maxAttempts: 3 });
  let failsLeft = 2; // fails twice (attempts 1,2), succeeds on attempt 3 — within maxAttempts
  const handler = () => {
    if (failsLeft > 0) {
      failsLeft -= 1;
      throw new Error("transient");
    }
  };
  q.add("recovers");
  q.process(handler);
  assert.deepEqual(q.stats(), { pending: 0, deadLettered: 0, processed: 1 });
});
