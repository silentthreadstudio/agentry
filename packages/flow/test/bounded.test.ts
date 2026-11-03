// bounded() — a stalled watcher step must resolve after the bound (and say so), never hang.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bounded } from "../src/channel/bounded.js";

const never = new Promise<void>(() => {});

test("bounded resolves as soon as the step settles", { timeout: 5000 }, async () => {
  const t0 = Date.now();
  await bounded(Promise.resolve(), "step", 2000);
  assert.ok(Date.now() - t0 < 1000);
});

test(
  "bounded resolves after the bound when the step never settles, and logs it",
  { timeout: 5000 },
  async (t) => {
    const write = t.mock.method(process.stderr, "write", () => true);
    await bounded(never, "stuck step", 50);
    assert.match(
      String(write.mock.calls[0]?.arguments[0]),
      /stuck step did not settle within 50 ms/,
    );
  },
);
