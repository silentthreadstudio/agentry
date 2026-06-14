import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryError, MemoryErrorCode } from "../src/errors.js";

test("MemoryError.parse accepts a well-formed envelope", () => {
  const envelope = {
    code: "not-found" as const,
    what: "The requested record does not exist.",
    why: 'No record was found for id "fact_1".',
    fix: "Pass an existing id.",
  };
  assert.deepEqual(MemoryError.parse(envelope), envelope);
});

test("MemoryError.parse rejects an empty-string what/why/fix", () => {
  const base = {
    code: "internal" as const,
    what: "a",
    why: "b",
    fix: "c",
  };
  for (const field of ["what", "why", "fix"] as const) {
    assert.throws(() => MemoryError.parse({ ...base, [field]: "" }), `empty ${field} must reject`);
  }
});

test("MemoryError.parse rejects a missing field", () => {
  assert.throws(() => MemoryError.parse({ code: "internal", what: "a", why: "b" }));
});

test("MemoryErrorCode set is closed — a non-member throws", () => {
  assert.throws(() => MemoryErrorCode.parse("storage"));
  assert.throws(() => MemoryErrorCode.parse("not-a-code"));
});

test("all five canonical codes parse", () => {
  for (const code of ["bad-input", "not-found", "invalid-state", "internal", "storage-read"]) {
    assert.equal(MemoryErrorCode.parse(code), code);
  }
});
