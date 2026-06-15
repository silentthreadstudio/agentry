// Tests for the pure shape-extractor (ADR-001 / AC2). ZERO API spend: every case runs `extractShape` over a
// HAND-BUILT synthetic NDJSON stream log on disk (no `claude -p`, no runner) plus the `ctx` settle signals.
//
// AC2 / R1 NOTE — REAL-RUN CAPTURES ARE PENDING R1. AC2 ultimately wants >=1 *real-run* captured stream per
// shape (one captured by running the live path once per shape). Those require a live `claude -p` and are
// BLOCKED ON R1 (the live-capture probe). The synthetic logs below PROVE THE FUNCTION — its dispatch parse,
// role-family mapping, one-shot disambiguation, noise tolerance, and degenerate fallback. They do NOT prove
// the live stream is disambiguable in practice; that is what the pending real captures will add. When R1's
// captures land, drop one real `*.stream.jsonl` per shape into test/fixtures/routing/ and add an assertion
// here that each returns its expected shape — the synthetic cases stay as the unit floor.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { DegenerateRunError, extractShape } from "../src/routing/extract.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "routing");
const streamPath = (name: string): string => join(FIXTURES, `${name}.stream.jsonl`);

// --- the three dispatched shapes, from synthetic logs --------------------------------------------------

test("product-owner + architect dispatched, no implementer => spec-first", () => {
  const shape = extractShape(streamPath("spec-first"), { producedTreeNonEmpty: true });
  assert.equal(shape, "spec-first");
});

test("an implementer in the dispatch set => decompose (even alongside an architect)", () => {
  const shape = extractShape(streamPath("decompose"), { producedTreeNonEmpty: true });
  assert.equal(shape, "decompose");
});

test("zero dispatch + settled success + non-empty produced tree => one-shot (the OQ1 disambiguator)", () => {
  const shape = extractShape(streamPath("one-shot"), {
    resultSubtype: "success",
    producedTreeNonEmpty: true,
  });
  assert.equal(shape, "one-shot");
});

// --- the degenerate no-dispatch case must NOT be mislabeled one-shot -----------------------------------

test("degenerate no-dispatch run (aborted, no settled result) does NOT return one-shot — it throws", () => {
  // No dispatch in the stream AND no settled `result` envelope (killed/aborted) => indeterminate, never one-shot.
  assert.throws(
    () => extractShape(streamPath("degenerate"), { producedTreeNonEmpty: false }),
    DegenerateRunError,
  );
});

test("no dispatch but result is not success => NOT one-shot, throws (degenerate)", () => {
  // Same degenerate stream, but the run settled with a non-success subtype: still never one-shot.
  assert.throws(
    () => extractShape(streamPath("degenerate"), { resultSubtype: "error_during_execution", producedTreeNonEmpty: true }),
    DegenerateRunError,
  );
});

test("no dispatch, settled success, but EMPTY produced tree => NOT one-shot, throws (degenerate)", () => {
  // The OQ1 disambiguator needs BOTH success AND a non-empty tree; success alone is not enough.
  assert.throws(
    () => extractShape(streamPath("degenerate"), { resultSubtype: "success", producedTreeNonEmpty: false }),
    DegenerateRunError,
  );
});

// --- robustness: the dispatch branch ignores the absent `result` and tolerates noise -------------------

test("a dispatched run is classified WITHOUT requiring a trailing result envelope", () => {
  // The spec-first / decompose logs carry no `result` line (a captured stream after early-terminate has none);
  // extraction must still succeed for the WITH-dispatch cases — only the one-shot branch consults resultSubtype.
  assert.equal(extractShape(streamPath("spec-first"), { producedTreeNonEmpty: false }), "spec-first");
  assert.equal(extractShape(streamPath("decompose"), { producedTreeNonEmpty: false }), "decompose");
});

test("non-JSON noise lines in the stream are tolerated, not fatal", () => {
  // spec-first.stream.jsonl deliberately contains a bare non-JSON line; classification still succeeds.
  assert.equal(extractShape(streamPath("spec-first"), { producedTreeNonEmpty: true }), "spec-first");
});
