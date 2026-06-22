// Conformance test for the UNIFIED rightsizing-fixture corpus + loader (T-04 / ADR-004) — ZERO live API by
// construction. It drives the REAL fs load of `fixtures/rightsizing/` via `loadRightsizingFixture`, then for each
// fixture asserts BOTH halves are real:
//   - the ROUTING axis: a `correctFloor`, a defended structured `rationale`, and second-labeler `labels`;
//   - the RESULT axis: the four subtrees + an `oracleCmd`, with the discrimination control PROVEN — seed+golden
//     PASSES the held-out oracle, seed+broken FAILS it, and an untouched seed FAILS it (the un-built control).
// It also asserts the SPREAD the controls need (≥1 must-escalate trap, ≥1 trivial one-shot, ≥1 over-route bait),
// and that the validator REJECTS the three malformed shapes the contract names (missing golden; seed/oracle
// overlap; a must-escalate without decision_hidden+consequence). The oracle is run directly over overlaid copies,
// exactly as T-03's discrimination control will — no `claude -p`, no API spend.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  loadRightsizingFixture,
  loadRightsizingFixtureDir,
  RightsizingFixtureError,
} from "../src/rightsizing/fixture.ts";
import type { RightsizingFixture } from "../src/rightsizing/fixture.ts";
import { injectOracle, runOracle } from "../src/rightsizing/oracle.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RIGHTSIZING_DIR = join(HERE, "..", "fixtures", "rightsizing");

const fixtures = loadRightsizingFixture(RIGHTSIZING_DIR);

/** Materialize seed (+ an optional golden/broken overlay) into a fresh sandbox, inject the oracle, run it. */
function runOracleOver(fx: RightsizingFixture, overlayDir: string | null): ReturnType<typeof runOracle> {
  const sandbox = mkdtempSync(join(tmpdir(), "rightsizing-fx-"));
  try {
    cpSync(fx.seedDir, sandbox, { recursive: true });
    if (overlayDir) cpSync(overlayDir, sandbox, { recursive: true });
    injectOracle(sandbox, fx.oracleDir);
    return runOracle(sandbox, fx.oracleCmd, fx.oracleTimeoutMs);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// --- corpus-level: the count + the spread the controls need (ADR-004) ------------------------------------------

test("corpus: loads ≥8 fully-dual fixtures (owner decision A)", () => {
  assert.ok(fixtures.length >= 8, `expected ≥8 fixtures, got ${fixtures.length}: ${fixtures.map((f) => f.id).join(", ")}`);
});

test("corpus: every fixture carries BOTH axes (routing label + result oracle)", () => {
  for (const fx of fixtures) {
    // routing axis
    assert.ok(["one-shot", "spec-first", "decompose"].includes(fx.correctFloor), `${fx.id}: bad correctFloor`);
    assert.ok(fx.rationale.governingSignal.length > 0, `${fx.id}: missing governingSignal`);
    assert.equal(fx.labels.agreement, true, `${fx.id}: labels.agreement must be true`);
    // result axis
    assert.ok(fx.oracleCmd.length > 0, `${fx.id}: missing oracleCmd`);
    for (const dir of [fx.seedDir, fx.oracleDir, fx.goldenDir, fx.brokenDir]) {
      assert.ok(statSync(dir).isDirectory(), `${fx.id}: missing subtree ${dir}`);
    }
  }
});

test("corpus: spans the spread — ≥1 must-escalate trap, ≥1 trivial one-shot, ≥1 over-route bait", () => {
  const escalateTrap = fixtures.filter(
    (f) => f.trap === "must-escalate" && f.correctFloor !== "one-shot",
  );
  const trivialOneShot = fixtures.filter((f) => f.correctFloor === "one-shot");
  // The over-route bait: a one-shot that LOOKS big — tagged must-not-over-orchestrate.
  const overRouteBait = fixtures.filter(
    (f) => f.trap === "must-not-over-orchestrate" && f.correctFloor === "one-shot",
  );

  assert.ok(escalateTrap.length >= 1, "no must-escalate trap (floor ≥ spec-first)");
  assert.ok(trivialOneShot.length >= 1, "no trivial one-shot");
  assert.ok(overRouteBait.length >= 1, "no over-route bait (must-not-over-orchestrate one-shot)");
});

// --- per-fixture: the discrimination control is REAL (golden passes, broken fails, seed fails) -----------------

for (const fx of fixtures) {
  test(`${fx.id}: seed+golden PASSES the oracle (discrimination, positive arm)`, () => {
    const r = runOracleOver(fx, fx.goldenDir);
    assert.equal(r.pass, true, r.output);
    assert.ok(r.total > 0 && r.passed === r.total, r.output);
  });

  test(`${fx.id}: seed+broken FAILS the oracle (discrimination, negative arm)`, () => {
    const r = runOracleOver(fx, fx.brokenDir);
    assert.equal(r.pass, false, r.output);
  });

  test(`${fx.id}: untouched seed FAILS the oracle (un-built control)`, () => {
    const r = runOracleOver(fx, null);
    assert.equal(r.pass, false, r.output);
  });
}

// --- the validator rejects malformed fixtures (the loud-failure guarantees the contract names) -----------------

/** Copy one real fixture into a fresh temp root so we can corrupt it without touching the shipped corpus. */
function clonedFixture(srcId: string): { root: string; fixtureDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rightsizing-bad-"));
  const fixtureDir = join(root, srcId);
  cpSync(join(RIGHTSIZING_DIR, srcId), fixtureDir, { recursive: true });
  return { root, fixtureDir };
}

test("rejects: a missing golden/ subtree (would starve the discrimination control)", () => {
  const { root, fixtureDir } = clonedFixture("rs-clamp");
  try {
    rmSync(join(fixtureDir, "golden"), { recursive: true, force: true });
    assert.throws(
      () => loadRightsizingFixtureDir(fixtureDir, "rs-clamp"),
      (err: unknown) => err instanceof RightsizingFixtureError && /golden/.test((err as Error).message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects: a seed/oracle overlap (the safety rule — oracle would be agent-visible)", () => {
  const { root, fixtureDir } = clonedFixture("rs-clamp");
  try {
    // Create the collision: a file at the SAME relative path under both seed/ and oracle/.
    writeFileSync(join(fixtureDir, "seed", "collide.txt"), "x");
    writeFileSync(join(fixtureDir, "oracle", "collide.txt"), "x");
    assert.throws(
      () => loadRightsizingFixtureDir(fixtureDir, "rs-clamp"),
      (err: unknown) => err instanceof RightsizingFixtureError && /overlap/.test((err as Error).message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects: a must-escalate fixture without decision_hidden+consequence rationale", () => {
  const { root, fixtureDir } = clonedFixture("rs-dedupe-key");
  try {
    // Rewrite fixture.yaml to keep the must-escalate trap but strip the required rationale evidence.
    writeFileSync(
      join(fixtureDir, "fixture.yaml"),
      [
        "id: rs-dedupe-key",
        "prompt: add a dedupe helper",
        "correct_floor: spec-first",
        "trap: must-escalate",
        "rationale:",
        "  governing_signal: a signal",
        "  seams: not the right evidence for a must-escalate",
        "labels: { labeler_a: a, labeler_b: b, agreement: true }",
        "oracle: { cmd: node --test oracle/*.test.js }",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => loadRightsizingFixtureDir(fixtureDir, "rs-dedupe-key"),
      (err: unknown) =>
        err instanceof RightsizingFixtureError && /must-escalate/.test((err as Error).message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects: a corpus with fewer than 8 fixtures (owner decision A delivery target)", () => {
  const root = mkdtempSync(join(tmpdir(), "rightsizing-thin-"));
  try {
    // Copy just two real fixtures into a thin corpus.
    for (const id of ["rs-clamp", "rs-temp-convert"]) {
      cpSync(join(RIGHTSIZING_DIR, id), join(root, id), { recursive: true });
    }
    assert.throws(
      () => loadRightsizingFixture(root),
      (err: unknown) => err instanceof RightsizingFixtureError && /≥8|>=8|8 /.test((err as Error).message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
