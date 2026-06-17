// Pure-core tests for the moat (memory-hygiene) dimension — the load-bearing logic with ZERO spend: the two
// control gates, the compound scoring, the seed id generator, and the recall-landing detector. The live probe
// (warm conductor runs) is exercised separately; these forced-testable pieces are where the integrity lives.

import { test } from "node:test";
import assert from "node:assert/strict";

import { seedLandingGuard, discriminationGuard } from "../src/moat/control.ts";
import { buildScoredArtifact, buildAbortedArtifact, censusRow, type MoatOutcome } from "../src/moat/artifact.ts";
import { newUlid } from "../src/moat/seed.ts";
import { recallLanded, factSurfaced } from "../src/moat/recall.ts";

// --- control: seed-landing (validity gate) -----------------------------------------------------------------------

test("seedLandingGuard: all relevant runs landed ⇒ ok", () => {
  const r = seedLandingGuard([true, true, true]);
  assert.equal(r.ok, true);
  assert.equal(r.landedCount, 3);
  assert.equal(r.verdict, undefined);
});

test("seedLandingGuard: any seed-miss ⇒ fail with seed-did-not-land", () => {
  const r = seedLandingGuard([true, false, true]);
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "seed-did-not-land");
  assert.equal(r.landedCount, 2);
});

test("seedLandingGuard: empty set is not a valid landing", () => {
  assert.equal(seedLandingGuard([]).ok, false);
});

// --- control: discrimination (power gate) ------------------------------------------------------------------------

test("discriminationGuard: relevant compounds where decoy holds ⇒ power", () => {
  const r = discriminationGuard([true, true], [false, false]);
  assert.equal(r.power, true);
  assert.equal(r.compoundRate, 1);
  assert.equal(r.decoyLightenRate, 0);
});

test("discriminationGuard: nothing compounds ⇒ no-compounding-detected", () => {
  const r = discriminationGuard([false, false], [false, false]);
  assert.equal(r.power, false);
  assert.equal(r.verdict, "no-compounding-detected");
});

test("discriminationGuard: decoy lightens as often as relevant ⇒ memory-agnostic-lightening", () => {
  const r = discriminationGuard([true, false], [true, false]);
  assert.equal(r.power, false);
  assert.equal(r.verdict, "memory-agnostic-lightening");
});

// --- scoring: census + artifact ----------------------------------------------------------------------------------

/** The proven case: dedupe routes spec-first cold; relevant recall → one-shot (compounds); decoy → stays spec-first. */
const COMPOUND_OUTCOME: MoatOutcome = {
  taskId: "routing-dedupe-key",
  coldFloor: "spec-first",
  relevant: { shape: "one-shot", landed: true },
  decoy: { shape: "spec-first", landed: true },
};

test("censusRow: relevant lighter-than-floor + landed ⇒ compounded; decoy at floor ⇒ held", () => {
  const row = censusRow(COMPOUND_OUTCOME);
  assert.equal(row.compounded, true);
  assert.equal(row.decoyHeld, true);
});

test("censusRow: relevant lighter but seed did NOT land ⇒ not compounded (unattributable)", () => {
  const row = censusRow({ ...COMPOUND_OUTCOME, relevant: { shape: "one-shot", landed: false } });
  assert.equal(row.compounded, false);
});

test("censusRow: decoy lighter than floor ⇒ decoyHeld false (the control broke)", () => {
  const row = censusRow({ ...COMPOUND_OUTCOME, decoy: { shape: "one-shot", landed: true } });
  assert.equal(row.decoyHeld, false);
});

test("buildScoredArtifact: rates + discrimination computed from the census", () => {
  const a = buildScoredArtifact([COMPOUND_OUTCOME]);
  assert.equal(a.condition, "scored");
  assert.equal(a.compoundRate, 1);
  assert.equal(a.decoyLightenRate, 0);
  assert.equal(a.discrimination, 1);
  assert.deepEqual(a.seedLanding, { landedCount: 1, total: 1 });
  assert.equal(a.census?.length, 1);
});

test("buildAbortedArtifact: no compound number, carries the verdict", () => {
  const a = buildAbortedArtifact("seed-did-not-land");
  assert.equal(a.condition, "aborted");
  assert.equal(a.compoundRate, null);
  assert.equal(a.abortVerdict, "seed-did-not-land");
  assert.equal(a.census, undefined);
});

// --- seed: ULID generator ----------------------------------------------------------------------------------------

test("newUlid: 26 valid Crockford chars, non-degenerate, deterministic per seed, distinct across seeds", () => {
  for (const seed of [0, 1, 2, 3, 4, 5]) {
    const u = newUlid(seed);
    assert.equal(u.length, 26);
    assert.match(u, /^[0-9A-HJKMNP-TV-Z]{26}$/); // Crockford base32 (no I, L, O, U)
    assert.notEqual(u, "0".repeat(26)); // not the all-zeros degenerate id (the Math.imul bug)
  }
  assert.equal(newUlid(2), newUlid(2)); // deterministic
  assert.equal(new Set([0, 1, 2, 3, 4, 5].map(newUlid)).size, 6); // all distinct
});

// --- recall: landing detector ------------------------------------------------------------------------------------

test("recallLanded: recall fired + non-empty ⇒ landed", () => {
  assert.equal(recallLanded("recalled the prior decision: dedupe by case-folded email", true), true);
});

test("recallLanded: an empty-recall tell ⇒ not landed (even if recall fired)", () => {
  assert.equal(recallLanded("Memory is empty — no precedent. Now let me inspect the code.", true), false);
  assert.equal(recallLanded("recall returned empty", true), false);
  assert.equal(recallLanded("the store is empty", true), false);
});

test("recallLanded: recall never fired ⇒ not landed", () => {
  assert.equal(recallLanded("plenty of text but no recall tool ran", false), false);
});

test("factSurfaced: matches a distinctive signature case-insensitively", () => {
  assert.equal(factSurfaced("…ids are NOT STABLE ACROSS IMPORTS, so…", "not stable across imports"), true);
  assert.equal(factSurfaced("unrelated reasoning", "not stable across imports"), false);
});
