// HIDDEN held-out oracle — encodes the SLIDING-window resolution of the fork. The boundary-burst probe is the
// discriminator: two hits late in one fixed bucket then two more just after the bucket edge stay INSIDE the
// trailing window, so a sliding limiter denies them; a fixed-window limiter wrongly resets and admits the burst.
const test = require("node:test");
const assert = require("node:assert/strict");

const { createLimiter } = require("../src/limiter.js");

/** A limiter whose clock returns whatever `clock.t` currently is. */
function at(limit, windowMs) {
  const clock = { t: 0 };
  const limiter = createLimiter({ limit, windowMs, now: () => clock.t });
  return { limiter, clock };
}

test("allows up to `limit` hits then denies within one window", () => {
  const { limiter, clock } = at(2, 1000);
  clock.t = 100;
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false, "the 3rd hit in the window is denied");
});

test("a hit aging out of the trailing window frees a slot", () => {
  const { limiter, clock } = at(1, 1000);
  clock.t = 0;
  assert.equal(limiter.allow("a"), true);
  clock.t = 500;
  assert.equal(limiter.allow("a"), false, "still inside the trailing 1000ms window");
  clock.t = 1001;
  assert.equal(limiter.allow("a"), true, "the first hit has aged out — a slot frees");
});

test("the boundary-burst probe: a sliding window denies the 2×limit burst a fixed window would let through", () => {
  const { limiter, clock } = at(2, 1000);
  // Two hits late in what a fixed window treats as bucket 0.
  clock.t = 900;
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  // Just past the fixed-bucket edge — but still within the trailing 1000ms of the two earlier hits.
  clock.t = 1001;
  assert.equal(limiter.allow("a"), false, "still 2 hits in the trailing window (901..1001] — must deny");
  clock.t = 1300;
  assert.equal(limiter.allow("a"), false, "the 900-hits are at 900<=cutoff=300? no — both still within (300,1300]");
});

test("limits are per-key", () => {
  const { limiter, clock } = at(1, 1000);
  clock.t = 0;
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("b"), true, "a separate key has its own budget");
  assert.equal(limiter.allow("a"), false);
});
