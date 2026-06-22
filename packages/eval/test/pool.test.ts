// Tests for the bounded-concurrency map (`mapPool`) — the parallel seam under both live probe loops. The
// contract under test is the one the probes rely on: order-preserving results, a hard ceiling on concurrent
// `fn` invocations, the degenerate limits (limit≥items, limit=1, empty), and Promise.all reject semantics.

import assert from "node:assert/strict";
import { test } from "node:test";

import { mapPool } from "../src/pool.ts";

/** A deferred — lets a test hold `fn` invocations open to observe how many run concurrently. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("results land at their input index (order preserved despite out-of-order completion)", async () => {
  // Later items resolve SOONER (descending delay) — if results were appended on completion they'd be reversed.
  const items = [0, 1, 2, 3, 4, 5];
  const out = await mapPool(items, 3, async (n) => {
    await new Promise((r) => setTimeout(r, (items.length - n) * 5));
    return n * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40, 50]);
});

test("never exceeds the concurrency limit (tracks live workers)", async () => {
  const limit = 3;
  const items = Array.from({ length: 12 }, (_, i) => i);
  let live = 0;
  let peak = 0;
  await mapPool(items, limit, async (n) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return n;
  });
  assert.ok(peak <= limit, `peak concurrency ${peak} must not exceed limit ${limit}`);
  assert.equal(peak, limit, "with more items than the limit, the pool should saturate to the limit");
});

test("limit >= items.length runs them all at once (bounded to items.length, not the limit)", async () => {
  const items = [1, 2, 3];
  let live = 0;
  let peak = 0;
  const gate = deferred<void>();
  const run = mapPool(items, 99, async (n) => {
    live++;
    peak = Math.max(peak, live);
    await gate.promise; // hold every invocation open so the peak reflects true simultaneity.
    live--;
    return n;
  });
  // Let the event loop start all the workers, then release them.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(peak, items.length, "all items in flight at once when limit >= count");
  gate.resolve();
  assert.deepEqual(await run, [1, 2, 3]);
});

test("limit = 1 is strictly serial (fn fires one at a time, in index order)", async () => {
  const order: number[] = [];
  let live = 0;
  let peak = 0;
  const out = await mapPool([10, 20, 30], 1, async (n) => {
    live++;
    peak = Math.max(peak, live);
    order.push(n);
    await new Promise((r) => setTimeout(r, 1));
    live--;
    return n;
  });
  assert.equal(peak, 1, "limit 1 ⇒ never more than one in flight");
  assert.deepEqual(order, [10, 20, 30], "limit 1 ⇒ invoked strictly in index order");
  assert.deepEqual(out, [10, 20, 30]);
});

test("empty input ⇒ [] (no workers spawned, fn never called)", async () => {
  let calls = 0;
  const out = await mapPool([], 4, async () => {
    calls++;
    return 1;
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test("a thrown fn rejects the whole pool (Promise.all semantics)", async () => {
  await assert.rejects(
    mapPool([1, 2, 3, 4], 2, async (n) => {
      if (n === 3) throw new Error("boom");
      return n;
    }),
    /boom/,
  );
});

test("a limit < 1 is clamped to a single serial worker", async () => {
  let peak = 0;
  let live = 0;
  const out = await mapPool([1, 2, 3], 0, async (n) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 1));
    live--;
    return n;
  });
  assert.equal(peak, 1, "limit 0 clamps to one worker (max(1, …))");
  assert.deepEqual(out, [1, 2, 3]);
});
