// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It drives the BUILT pipeline
// through src/index.js (which must coordinate src/rules.js + src/runner.js) and asserts the contract: the all-pass
// happy path AND the first-error-only, short-circuit-order, and result-shape TRAP cases that only an ordered,
// short-circuiting runner satisfies.

const test = require("node:test");
const assert = require("node:assert/strict");

const { validate, required, minLength, isEmail } = require("../src/index.js");

// --- happy path: every rule passes ---
test("returns ok with no errors when all rules pass", () => {
  const result = validate({ name: "Ada", email: "ada@example.com" }, [
    required("name"),
    minLength("name", 2),
    isEmail("email"),
  ]);
  assert.deepEqual(result, { ok: true, errors: [] });
});

// --- TRAP: only the FIRST failing rule's message is returned ---
test("returns only the first failing rule's message", () => {
  const result = validate({ name: "", email: "nope" }, [
    required("name"), // fails first
    isEmail("email"), // would also fail, but must not be reported
  ]);
  assert.deepEqual(result, { ok: false, errors: ["name is required"] });
});

// --- TRAP: rules run IN ORDER and short-circuit — a later rule is never called after a failure ---
test("short-circuits: rules after the first failure are not run", () => {
  let laterRan = false;
  const spy = () => {
    laterRan = true;
    return "should never be reported";
  };
  const result = validate({ name: "" }, [required("name"), spy]);
  assert.equal(laterRan, false, "the rule after the first failure must not run");
  assert.deepEqual(result, { ok: false, errors: ["name is required"] });
});

// --- TRAP: order matters — the first rule in the list that fails wins ---
test("the first failing rule in order wins", () => {
  const result = validate({ name: "x" }, [
    minLength("name", 5), // fails first in this ordering
    required("name"), // passes ("x" is present) — irrelevant after short-circuit anyway
  ]);
  assert.deepEqual(result, { ok: false, errors: ["name must be at least 5 characters"] });
});

// --- result shape: errors is always an array; ok reflects pass/fail ---
test("a single passing rule yields ok:true", () => {
  const result = validate({ email: "a@b.co" }, [isEmail("email")]);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("an email rule failure is reported as the only error", () => {
  const result = validate({ email: "not-an-email" }, [isEmail("email")]);
  assert.deepEqual(result, { ok: false, errors: ["email must be a valid email"] });
});
