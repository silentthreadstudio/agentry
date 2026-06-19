// ids — mintRun / assertSafeSegment traversal-safety (the run segment can never escape work/), plus
// formatTaskNo zero-padding.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSafeSegment, formatTaskNo, mintRun } from "../src/domain/ids.js";

test("assertSafeSegment rejects traversal sequences", () => {
  assert.throws(() => assertSafeSegment(".."));
  assert.throws(() => assertSafeSegment("a/b"));
  assert.throws(() => assertSafeSegment("a\\b"));
  assert.throws(() => assertSafeSegment("../escape"));
  assert.throws(() => assertSafeSegment("")); // empty is a misuse, not a valid segment
  assert.throws(() => assertSafeSegment("   "));
});

test("assertSafeSegment accepts a clean single segment", () => {
  assert.doesNotThrow(() => assertSafeSegment("add-pagination-9f3k2a"));
});

test("mintRun produces a single traversal-safe segment from any goal", () => {
  const run = mintRun("Add pagination to the users endpoint");
  assert.doesNotThrow(() => assertSafeSegment(run));
  assert.match(run, /^add-pagination-to-the-users-endpoint-[a-z0-9]+$/);
});

test("mintRun stays safe even when the goal is hostile/punctuation-only", () => {
  for (const goal of ["../../etc/passwd", "////", "...", "a/b\\c"]) {
    const run = mintRun(goal);
    assert.doesNotThrow(() => assertSafeSegment(run), `run "${run}" from goal "${goal}" must be safe`);
  }
});

test("mintRun is collision-resistant across rapid calls", () => {
  const a = mintRun("same goal");
  const b = mintRun("same goal");
  assert.notEqual(a, b);
});

test("formatTaskNo zero-pads to NNN", () => {
  assert.equal(formatTaskNo(1), "001");
  assert.equal(formatTaskNo(42), "042");
  assert.equal(formatTaskNo(123), "123");
});
