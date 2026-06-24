// HIDDEN held-out oracle — encodes the "only retriable errors retry" resolution. The non-retriable probe counts
// fn invocations: a non-retriable throw must call fn EXACTLY once (fail fast). The retry-everything broken build
// calls it retries+1 times and FAILS.
const test = require("node:test");
const assert = require("node:assert/strict");

const { withRetry } = require("../src/retry.js");

function retriable(msg) {
  return Object.assign(new Error(msg), { retriable: true });
}
function fatal(msg) {
  return Object.assign(new Error(msg), { retriable: false });
}

test("returns the value when fn succeeds first try", () => {
  let calls = 0;
  assert.equal(
    withRetry(() => {
      calls += 1;
      return 42;
    }, { retries: 3 }),
    42,
  );
  assert.equal(calls, 1);
});

test("retries a retriable error and eventually succeeds", () => {
  let calls = 0;
  const out = withRetry(() => {
    calls += 1;
    if (calls < 3) throw retriable("flaky");
    return "ok";
  }, { retries: 3 });
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

test("the fork probe: a NON-retriable error rethrows immediately, consuming no retries", () => {
  let calls = 0;
  assert.throws(
    () =>
      withRetry(() => {
        calls += 1;
        throw fatal("bad request");
      }, { retries: 3 }),
    /bad request/,
  );
  assert.equal(calls, 1, "a non-retriable error must NOT be retried — fn called exactly once");
});

test("a persistently retriable error exhausts the retries then throws the last error", () => {
  let calls = 0;
  assert.throws(
    () =>
      withRetry(() => {
        calls += 1;
        throw retriable("still flaky");
      }, { retries: 2 }),
    /still flaky/,
  );
  assert.equal(calls, 3, "1 initial + 2 retries");
});
