// Conformance test for the WHOLE outcome-fixture corpus (T5 / AC3) — ZERO live API by construction. It walks
// every `fixtures/outcome/<id>/` directory and, for each, asserts the three load-time + discrimination controls
// the matrix's ground truth depends on (Spec AC3/AC5): the fixture LOADS via `loadOutcomeFixture`; seed+golden
// PASSES the held-out oracle (positive arm); seed+broken FAILS it (negative arm); and an untouched seed FAILS it
// (the no-leakage / un-built control). No `claude -p`, no API spend — the oracle is run directly over overlaid
// copies, exactly as the discrimination control does in outcome-slice.test.ts.
//
// It also asserts the CORPUS-LEVEL coverage AC3 demands: ≥8 fixtures spanning all three shapes and ≥2 kinds.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadOutcomeFixture } from "../src/conduct/fixture.ts";
import type { OutcomeFixture } from "../src/conduct/fixture.ts";
import { injectOracle, runOracle } from "../src/conduct/oracle.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTCOME_DIR = join(HERE, "..", "fixtures", "outcome");

/** The id of every directory under `fixtures/outcome/` — one per planted fixture. */
function fixtureIds(): string[] {
  return readdirSync(OUTCOME_DIR)
    .filter((name) => statSync(join(OUTCOME_DIR, name)).isDirectory())
    .sort();
}

/** Materialize seed (+ an optional golden/broken overlay) into a fresh sandbox, inject the oracle, run it. */
function runOracleOver(fx: OutcomeFixture, overlayDir: string | null): ReturnType<typeof runOracle> {
  const sandbox = mkdtempSync(join(tmpdir(), "outcome-fx-"));
  try {
    cpSync(fx.seedDir, sandbox, { recursive: true });
    if (overlayDir) cpSync(overlayDir, sandbox, { recursive: true });
    injectOracle(sandbox, fx.oracleDir);
    return runOracle(sandbox, fx.oracleCmd, fx.oracleTimeoutMs);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const ids = fixtureIds();

// --- per-fixture: loads + the three discrimination/leakage controls (AC3/AC5) ----------------------------------

for (const id of ids) {
  const fixtureDir = join(OUTCOME_DIR, id);

  test(`${id}: loads via loadOutcomeFixture (structure + disjoint seed/oracle)`, () => {
    const fx = loadOutcomeFixture(fixtureDir);
    assert.equal(fx.id, id, "fixture.yaml id must match its directory name");
    assert.ok(fx.prompt.length > 0);
  });

  test(`${id}: seed+golden PASSES the oracle (discrimination, positive arm)`, () => {
    const fx = loadOutcomeFixture(fixtureDir);
    const r = runOracleOver(fx, fx.goldenDir);
    assert.equal(r.pass, true, r.output);
    assert.ok(r.total > 0 && r.passed === r.total, r.output);
  });

  test(`${id}: seed+broken FAILS the oracle (discrimination, negative arm)`, () => {
    const fx = loadOutcomeFixture(fixtureDir);
    const r = runOracleOver(fx, fx.brokenDir);
    assert.equal(r.pass, false, r.output);
  });

  test(`${id}: untouched seed FAILS the oracle (no-leakage / un-built control)`, () => {
    const fx = loadOutcomeFixture(fixtureDir);
    const r = runOracleOver(fx, null);
    assert.equal(r.pass, false, r.output);
  });
}

// --- corpus-level coverage (AC3): ≥8 fixtures spanning all three shapes and ≥2 kinds ---------------------------

test("corpus: at least 8 fixtures are present", () => {
  assert.ok(ids.length >= 8, `expected ≥8 outcome fixtures, found ${ids.length}: ${ids.join(", ")}`);
});

test("corpus: the labeled shapes cover one-shot, spec-first, AND decompose", () => {
  const shapes = new Set(ids.map((id) => loadOutcomeFixture(join(OUTCOME_DIR, id)).shape));
  for (const required of ["one-shot", "spec-first", "decompose"] as const) {
    assert.ok(shapes.has(required), `no fixture labeled shape="${required}" — have ${[...shapes].join(", ")}`);
  }
});

test("corpus: the labeled kinds cover at least feature + bug", () => {
  const kinds = new Set(ids.map((id) => loadOutcomeFixture(join(OUTCOME_DIR, id)).kind));
  assert.ok(kinds.has("feature"), `no fixture labeled kind="feature" — have ${[...kinds].join(", ")}`);
  assert.ok(kinds.has("bug"), `no fixture labeled kind="bug" — have ${[...kinds].join(", ")}`);
});
