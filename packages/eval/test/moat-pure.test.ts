// Pure-core tests for the moat (memory-hygiene) dimension — the load-bearing logic with ZERO spend: the two
// control gates, the compound scoring, the seed id generator, and the recall-landing detector. The live probe
// (warm conductor runs) is exercised separately; these forced-testable pieces are where the integrity lives.

import { test } from "node:test";
import assert from "node:assert/strict";

import { seedLandingGuard, discriminationGuard } from "../src/moat/control.ts";
import { buildScoredArtifact, buildAbortedArtifact, censusRow, taskCensus, type MoatOutcome } from "../src/moat/artifact.ts";
import { newUlid } from "../src/moat/seed.ts";
import { recallLanded, factSurfaced } from "../src/moat/recall.ts";

/** Round to 2 decimals — the fractions are exact thirds, compared at 2dp to dodge float noise. */
const round = (x: number): number => Math.round(x * 100) / 100;

// --- control: seed-landing (validity gate) -----------------------------------------------------------------------

test("seedLandingGuard: all relevant runs landed ⇒ ok", () => {
  const r = seedLandingGuard([true, true, true]);
  assert.equal(r.ok, true);
  assert.equal(r.landedCount, 3);
  assert.equal(r.rate, 1);
  assert.equal(r.verdict, undefined);
});

test("seedLandingGuard: rate at-or-above the floor ⇒ ok (a transient miss is tolerated at k>1)", () => {
  // 2/3 landed = 0.67 ≥ the default 0.5 floor ⇒ the measurement still has enough validity to trust.
  const r = seedLandingGuard([true, false, true]);
  assert.equal(r.ok, true);
  assert.equal(r.landedCount, 2);
  assert.equal(Math.round(r.rate * 100) / 100, 0.67);
  assert.equal(r.verdict, undefined);
});

test("seedLandingGuard: rate below the floor ⇒ fail with seed-did-not-land", () => {
  // 1/3 landed = 0.33 < the default 0.5 floor ⇒ memory was exercised on too few relevant runs to trust.
  const r = seedLandingGuard([true, false, false]);
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "seed-did-not-land");
  assert.equal(r.landedCount, 1);
});

test("seedLandingGuard: explicit floor is honored (a strict floor of 1 demands every run land)", () => {
  assert.equal(seedLandingGuard([true, false, true], 1).ok, false);
  assert.equal(seedLandingGuard([true, true, true], 1).ok, true);
});

test("seedLandingGuard: empty set is not a valid landing", () => {
  assert.equal(seedLandingGuard([]).ok, false);
});

// --- control: discrimination (power gate) ------------------------------------------------------------------------

test("discriminationGuard: relevant compounds where decoy holds ⇒ power", () => {
  const r = discriminationGuard(1, 0);
  assert.equal(r.power, true);
  assert.equal(r.compoundRate, 1);
  assert.equal(r.decoyLightenRate, 0);
});

test("discriminationGuard: nothing compounds ⇒ no-compounding-detected", () => {
  const r = discriminationGuard(0, 0);
  assert.equal(r.power, false);
  assert.equal(r.verdict, "no-compounding-detected");
});

test("discriminationGuard: decoy lightens as often as relevant ⇒ memory-agnostic-lightening", () => {
  const r = discriminationGuard(0.5, 0.5);
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

test("buildScoredArtifact: rates + discrimination computed from a single repeat (k=1)", () => {
  const a = buildScoredArtifact([COMPOUND_OUTCOME]);
  assert.equal(a.condition, "scored");
  assert.equal(a.compoundRate, 1);
  assert.equal(a.decoyLightenRate, 0);
  assert.equal(a.discrimination, 1);
  assert.equal(a.seedLandingRate, 1);
  assert.deepEqual(a.seedLanding, { landedCount: 1, total: 1 });
  assert.equal(a.runs, 1);
  assert.equal(a.census?.length, 1);
});

// --- k>1 AGGREGATION: rates over repeats, indeterminate non-landed repeats excluded ------------------------------

/** A relevant repeat that LANDED its seed but did NOT route lighter (held at the cold floor). */
const RELEVANT_LANDED_HELD: MoatOutcome = {
  taskId: "routing-dedupe-key",
  coldFloor: "spec-first",
  relevant: { shape: "spec-first", landed: true },
  decoy: { shape: "spec-first", landed: true },
};
/** A relevant repeat where recall did NOT land — INDETERMINATE (excluded from the compound fraction entirely). */
const RELEVANT_NOT_LANDED: MoatOutcome = {
  taskId: "routing-dedupe-key",
  coldFloor: "spec-first",
  relevant: { shape: "one-shot", landed: false },
  decoy: { shape: "spec-first", landed: true },
};
/** A decoy repeat that (wrongly) lightened — the false-positive event the decoyLightenRate measures. */
const DECOY_LIGHTENED: MoatOutcome = {
  taskId: "routing-dedupe-key",
  coldFloor: "spec-first",
  relevant: { shape: "one-shot", landed: true },
  decoy: { shape: "one-shot", landed: true },
};

test("buildScoredArtifact k=3: relevant lands+compounds 2/3, decoy lightens 1/3 ⇒ stable rates + discrimination", () => {
  // 3 repeats of one task: 2 compound (landed + lighter), 1 lands-but-holds; 1 decoy lightens.
  const repeats = [COMPOUND_OUTCOME, COMPOUND_OUTCOME, { ...RELEVANT_LANDED_HELD, decoy: DECOY_LIGHTENED.decoy }];
  const a = buildScoredArtifact(repeats, 3);
  assert.equal(a.condition, "scored");
  assert.equal(a.runs, 3);
  // compoundRate = 2 compounded / 3 landed relevant repeats (all 3 landed).
  assert.equal(round(a.compoundRate!), 0.67);
  // decoyLightenRate = 1 decoy lightened / 3 decoy repeats (no landing filter).
  assert.equal(round(a.decoyLightenRate!), 0.33);
  assert.equal(round(a.discrimination!), 0.33);
  assert.equal(a.seedLandingRate, 1);
  // one task census row, carrying the per-task fractions + a spread.
  assert.equal(a.census?.length, 1);
  const c = a.census![0]!;
  assert.equal(round(c.relevantCompoundedFraction!), 0.67);
  assert.equal(round(c.decoyLightenedFraction), 0.33);
  assert.equal(c.landedRepeats, 3);
  assert.equal(c.repeats, 3);
  assert.ok(c.compoundedSpread > 0, "a 2/3 split has non-zero spread");
});

test("buildScoredArtifact: a non-landed relevant repeat is INDETERMINATE — excluded from compoundRate's num AND denom", () => {
  // 3 repeats: 1 compounds (landed+lighter), 1 lands-but-holds, 1 did NOT land. The non-landed repeat must NOT
  // dilute the compound denominator — compoundRate = 1 compounded / 2 LANDED = 0.5, not 1/3.
  const a = buildScoredArtifact([COMPOUND_OUTCOME, RELEVANT_LANDED_HELD, RELEVANT_NOT_LANDED], 3);
  assert.equal(a.compoundRate, 0.5);
  assert.equal(round(a.seedLandingRate!), 0.67); // 2 of 3 relevant repeats landed
  assert.deepEqual(a.seedLanding, { landedCount: 2, total: 3 });
  const c = a.census![0]!;
  assert.equal(c.landedRepeats, 2);
  assert.equal(c.relevantCompoundedFraction, 0.5);
});

test("buildScoredArtifact: a task whose every relevant repeat MISSED ⇒ null compound fraction (no basis)", () => {
  const a = buildScoredArtifact([RELEVANT_NOT_LANDED, RELEVANT_NOT_LANDED], 2);
  assert.equal(a.compoundRate, 0); // no landed repeat anywhere ⇒ 0
  assert.equal(a.seedLandingRate, 0);
  assert.equal(a.census![0]!.relevantCompoundedFraction, null);
});

test("taskCensus: rolls k repeats into fractions + spread, landed-only compound denominator", () => {
  const c = taskCensus([COMPOUND_OUTCOME, COMPOUND_OUTCOME, RELEVANT_NOT_LANDED]);
  assert.equal(c.taskId, "routing-dedupe-key");
  assert.equal(c.repeats, 3);
  assert.equal(c.landedRepeats, 2);
  assert.equal(c.relevantCompoundedFraction, 1); // both LANDED repeats compounded ⇒ 1, the missed one is excluded
  assert.equal(c.compoundedSpread, 0); // a unanimous landed set ⇒ zero spread
  assert.equal(round(c.seedLandedFraction), 0.67);
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
