// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It requires the agent's BUILT
// src/retry.js and asserts the retry contract: succeed-on-Nth (happy path) AND the error-semantics TRAP cases.
// It injects a FAKE no-op `sleep` so no real timers run — the suite is fast and deterministic.

const test = require("node:test");
const assert = require("node:assert/strict");

const { retry } = require("../src/retry.js");

const noSleep = () => Promise.resolve();

// --- happy path: succeeds on the Nth try ---
test("returns the value on the first success after transient failures", async () => {
  let calls = 0;
  const result = await retry(
    (attempt) => {
      calls++;
      if (attempt < 3) return Promise.reject(new Error("transient"));
      return Promise.resolve(`ok@${attempt}`);
    },
    { attempts: 5, isRetryable: () => true, sleep: noSleep },
  );
  assert.equal(result, "ok@3");
  assert.equal(calls, 3, "should stop calling once it succeeds");
});

test("returns immediately when the first call succeeds", async () => {
  let calls = 0;
  const result = await retry(
    () => {
      calls++;
      return Promise.resolve("done");
    },
    { attempts: 3, sleep: noSleep },
  );
  assert.equal(result, "done");
  assert.equal(calls, 1);
});

// --- TRAP: a non-retryable error is thrown immediately, with no retry ---
test("a non-retryable error throws on the first call without retrying", async () => {
  let calls = 0;
  const fatal = new Error("fatal");
  fatal.code = "FATAL";
  await assert.rejects(
    () =>
      retry(
        () => {
          calls++;
          return Promise.reject(fatal);
        },
        { attempts: 5, isRetryable: (e) => e.code !== "FATAL", sleep: noSleep },
      ),
    (err) => err === fatal, // the ORIGINAL error, not a wrapper
  );
  assert.equal(calls, 1, "must not retry a non-retryable error");
});

// --- TRAP: after exhausting attempts, the LAST error is surfaced unchanged ---
test("after exhausting attempts it throws the LAST error, unchanged", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retry(
        (attempt) => {
          calls++;
          const err = new Error(`err${attempt}`);
          err.attempt = attempt;
          return Promise.reject(err);
        },
        { attempts: 3, isRetryable: () => true, sleep: noSleep },
      ),
    (err) => err.attempt === 3 && err.message === "err3", // the last error, identity preserved
  );
  assert.equal(calls, 3, "must stop at the attempt cap");
});
