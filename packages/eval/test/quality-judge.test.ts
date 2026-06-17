// Tests for the decision-quality judge (design §2). ZERO API spend: every case drives `judgeArtifact` through an
// INJECTED judge fn that returns canned JSON — no `claude -p` ever runs. This proves the parse + range
// validation + overall normalization (the judge's contract), and that the prompt embeds the rubric's content
// clause. The LIVE judge call (`realJudgeFn`) is exercised only R-gated, never here.

import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeArtifact, parseQualityScore, buildJudgePrompt, type JudgeFn } from "../src/quality/judge.ts";

/** A judge fn that returns a fixed JSON string regardless of prompt — the canned-score seam. */
function cannedJudge(json: string): JudgeFn {
  return () => json;
}

/** A well-formed canned verdict with the given per-dimension scores. */
function cannedDims(d: {
  forkSurfacing: number;
  decisionSoundness: number;
  accountability: number;
  scope: number;
  coherence: number;
}): string {
  return JSON.stringify({ dimensions: d, rationale: "canned" });
}

// --- happy path: a well-formed verdict parses, validates, and normalizes overall = sum/10 -------------

test("judgeArtifact: a well-formed verdict parses into dimensions + overall(sum/10) + rationale", async () => {
  const judge = cannedJudge(
    cannedDims({ forkSurfacing: 2, decisionSoundness: 2, accountability: 2, scope: 1, coherence: 2 }),
  );
  const score = await judgeArtifact("task", "artifact", { judge });
  assert.deepEqual(score.dimensions, {
    forkSurfacing: 2,
    decisionSoundness: 2,
    accountability: 2,
    scope: 1,
    coherence: 2,
  });
  // sum = 9 → 9/10 = 0.9.
  assert.equal(score.overall, 0.9);
  assert.equal(score.rationale, "canned");
});

test("judgeArtifact: an all-zero verdict normalizes to overall 0", async () => {
  const judge = cannedJudge(
    cannedDims({ forkSurfacing: 0, decisionSoundness: 0, accountability: 0, scope: 0, coherence: 0 }),
  );
  const score = await judgeArtifact("task", "artifact", { judge });
  assert.equal(score.overall, 0);
});

test("judgeArtifact: a perfect verdict normalizes to overall 1", async () => {
  const judge = cannedJudge(
    cannedDims({ forkSurfacing: 2, decisionSoundness: 2, accountability: 2, scope: 2, coherence: 2 }),
  );
  const score = await judgeArtifact("task", "artifact", { judge });
  assert.equal(score.overall, 1);
});

test("judgeArtifact: the model's own `overall` is IGNORED — overall is recomputed from dimensions", async () => {
  // A model that emits a flattering overall must not skew the score — the harness recomputes from dimensions.
  const judge = cannedJudge(
    JSON.stringify({
      dimensions: { forkSurfacing: 1, decisionSoundness: 1, accountability: 1, scope: 1, coherence: 1 },
      overall: 0.99, // lie — should be ignored
      rationale: "x",
    }),
  );
  const score = await judgeArtifact("task", "artifact", { judge });
  assert.equal(score.overall, 0.5); // sum 5 / 10, not 0.99
});

// --- range validation: out-of-range / non-integer / missing dimensions are malformed verdicts ----------

test("parseQualityScore: a dimension above 2 is rejected", () => {
  const raw = JSON.stringify({
    dimensions: { forkSurfacing: 3, decisionSoundness: 2, accountability: 2, scope: 2, coherence: 2 },
  });
  assert.throws(() => parseQualityScore(raw), /forkSurfacing.*0\.\.2/);
});

test("parseQualityScore: a negative dimension is rejected", () => {
  const raw = JSON.stringify({
    dimensions: { forkSurfacing: -1, decisionSoundness: 2, accountability: 2, scope: 2, coherence: 2 },
  });
  assert.throws(() => parseQualityScore(raw), /forkSurfacing/);
});

test("parseQualityScore: a non-integer dimension is rejected", () => {
  const raw = JSON.stringify({
    dimensions: { forkSurfacing: 1.5, decisionSoundness: 2, accountability: 2, scope: 2, coherence: 2 },
  });
  assert.throws(() => parseQualityScore(raw), /forkSurfacing/);
});

test("parseQualityScore: a missing dimension is rejected (all five required)", () => {
  const raw = JSON.stringify({
    dimensions: { forkSurfacing: 2, decisionSoundness: 2, accountability: 2, scope: 2 }, // no coherence
  });
  assert.throws(() => parseQualityScore(raw), /coherence/);
});

test("parseQualityScore: non-JSON output is rejected loudly", () => {
  assert.throws(() => parseQualityScore("not json at all"), /valid JSON/);
});

test("parseQualityScore: JSON without a dimensions object is rejected", () => {
  assert.throws(() => parseQualityScore(JSON.stringify({ rationale: "x" })), /dimensions/);
});

test("parseQualityScore: a missing rationale degrades to empty string (terse, not malformed)", () => {
  const raw = JSON.stringify({
    dimensions: { forkSurfacing: 2, decisionSoundness: 2, accountability: 2, scope: 2, coherence: 2 },
  });
  const score = parseQualityScore(raw);
  assert.equal(score.rationale, "");
});

// --- the prompt embeds the rubric's content clause (length must not score) -----------------------------

test("buildJudgePrompt: the prompt tells the judge to grade CONTENT, not length/formatting", () => {
  const prompt = buildJudgePrompt("the task", "the artifact");
  assert.match(prompt, /JUDGE CONTENT, NOT LENGTH OR FORMATTING/);
  assert.match(prompt, /the task/);
  assert.match(prompt, /the artifact/);
});
