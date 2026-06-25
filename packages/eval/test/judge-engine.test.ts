// Tests for the shared judge engine (ADR-002). ZERO API spend: every case drives `judgeWithRubric` through an
// INJECTED judge fn that returns canned JSON — no `claude -p` ever runs (`realJudgeFn` is exercised only R-gated).
// This proves the rubric-parameterized parse + range validation + overall normalization (`sum / rubric.max`, the
// anti-flattery contract), and that one engine normalizes a 4-dim and a 5-dim rubric correctly through one path.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  judgeWithRubric,
  parseScore,
  buildJudgePrompt,
  makeRubric,
  overallFromDimensions,
  type JudgeFn,
  type Rubric,
} from "../src/judge/index.ts";

/** A judge fn that returns a fixed JSON string regardless of prompt — the canned-score seam. */
function cannedJudge(json: string): JudgeFn {
  return () => json;
}

// A 4-dim rubric (max 8) and a 5-dim rubric (max 10) — to prove the engine reads `max` off the value.
const FOUR_DIM: Rubric = makeRubric(["a", "b", "c", "d"], "FOUR-DIM RUBRIC TEXT");
const FIVE_DIM: Rubric = makeRubric(["v", "w", "x", "y", "z"], "FIVE-DIM RUBRIC TEXT");

/** A well-formed canned verdict from a per-dimension score map. */
function cannedDims(d: Record<string, number>): string {
  return JSON.stringify({ dimensions: d, rationale: "canned" });
}

// --- the Rubric value: max derived from the fixed 0/1/2 vocabulary --------------------------------------

test("makeRubric: max is dimensions.length * 2 (the fixed 0/1/2 vocabulary)", () => {
  assert.equal(FOUR_DIM.max, 8);
  assert.equal(FIVE_DIM.max, 10);
});

test("overallFromDimensions: normalizes sum / rubric.max", () => {
  assert.equal(overallFromDimensions(FOUR_DIM, { a: 2, b: 2, c: 2, d: 1 }), 7 / 8);
  assert.equal(overallFromDimensions(FIVE_DIM, { v: 2, w: 2, x: 2, y: 2, z: 2 }), 1);
});

// --- happy path: a well-formed verdict parses, validates, normalizes overall = sum / rubric.max ----------

test("judgeWithRubric: a well-formed 4-dim verdict parses into dimensions + overall(sum/8) + rationale", async () => {
  const judge = cannedJudge(cannedDims({ a: 2, b: 2, c: 2, d: 1 }));
  const score = await judgeWithRubric(FOUR_DIM, "task", "subject", { judge });
  assert.deepEqual(score.dimensions, { a: 2, b: 2, c: 2, d: 1 });
  assert.equal(score.overall, 0.875); // 7/8
  assert.equal(score.rationale, "canned");
});

test("judgeWithRubric: a 5-dim rubric normalizes against its OWN max (sum/10), not a hardcoded 8", async () => {
  const judge = cannedJudge(cannedDims({ v: 1, w: 1, x: 1, y: 1, z: 1 }));
  const score = await judgeWithRubric(FIVE_DIM, "task", "subject", { judge });
  assert.equal(score.overall, 0.5); // sum 5 / 10
});

test("judgeWithRubric: an all-zero verdict normalizes to overall 0", async () => {
  const judge = cannedJudge(cannedDims({ a: 0, b: 0, c: 0, d: 0 }));
  const score = await judgeWithRubric(FOUR_DIM, "task", "subject", { judge });
  assert.equal(score.overall, 0);
});

test("judgeWithRubric: a perfect verdict normalizes to overall 1", async () => {
  const judge = cannedJudge(cannedDims({ a: 2, b: 2, c: 2, d: 2 }));
  const score = await judgeWithRubric(FOUR_DIM, "task", "subject", { judge });
  assert.equal(score.overall, 1);
});

test("judgeWithRubric: the model's own `overall` is IGNORED — overall is recomputed from dimensions", async () => {
  const judge = cannedJudge(
    JSON.stringify({ dimensions: { a: 1, b: 1, c: 1, d: 1 }, overall: 0.99, rationale: "x" }),
  );
  const score = await judgeWithRubric(FOUR_DIM, "task", "subject", { judge });
  assert.equal(score.overall, 0.5); // sum 4 / 8, not the model's 0.99
});

// --- range validation: out-of-range / non-integer / missing dimensions are malformed verdicts -----------

test("parseScore: a dimension above 2 is rejected", () => {
  assert.throws(() => parseScore(FOUR_DIM, cannedDims({ a: 3, b: 2, c: 2, d: 2 })), /a.*0\.\.2/);
});

test("parseScore: a negative dimension is rejected", () => {
  assert.throws(() => parseScore(FOUR_DIM, cannedDims({ a: -1, b: 2, c: 2, d: 2 })), /"a"/);
});

test("parseScore: a non-integer dimension is rejected", () => {
  assert.throws(() => parseScore(FOUR_DIM, cannedDims({ a: 1.5, b: 2, c: 2, d: 2 })), /"a"/);
});

// --- robustness: a real `claude -p` answer routinely fences or prose-wraps the JSON; extract it ----------

test("parseScore: tolerates a ```json fenced answer (real-judge decoration)", () => {
  const fenced = "```json\n" + cannedDims({ a: 2, b: 1, c: 2, d: 1 }) + "\n```";
  assert.equal(parseScore(FOUR_DIM, fenced).overall, 0.75); // 6/8
});

test("parseScore: tolerates a prose preamble/postamble around the object", () => {
  const wrapped = `Here is my evaluation:\n\n${cannedDims({ a: 1, b: 1, c: 1, d: 1 })}\n\nLet me know if you need more.`;
  assert.equal(parseScore(FOUR_DIM, wrapped).overall, 0.5); // 4/8
});

test("parseScore: still throws loudly when there is no JSON object at all", () => {
  assert.throws(() => parseScore(FOUR_DIM, "I cannot evaluate this."), /did not return valid JSON/);
});

// --- robustness: a long rationale can run past the output budget and TRUNCATE the JSON tail; the GRADE (dimensions,
//     emitted FIRST) must survive — a mangled rationale must not discard a valid verdict --------------------------

test("parseScore: recovers the dimensions when a long rationale truncates the JSON tail", () => {
  // The model emitted a valid dimensions block, then a rationale string the output budget cut mid-sentence — so the
  // closing `"` + `}` never arrive. The full parse fails; the dimensions-only recovery salvages the grade.
  const truncated = `{"dimensions":{"a":2,"b":1,"c":2,"d":1},"rationale":"The implementation handles the empty case and the`;
  const score = parseScore(FOUR_DIM, truncated);
  assert.equal(score.overall, 0.75); // 6/8 — the grade survives
  assert.equal(score.rationale, ""); // the truncated rationale is dropped, not faked
});

test("parseScore: a truncated tail with a malformed dimensions block still throws loudly", () => {
  // Recovery only salvages a BALANCED, valid dimensions block; a dimensions block that is itself cut stays a hard fail.
  const garbled = `{"dimensions":{"a":2,"b":1,"c":`;
  assert.throws(() => parseScore(FOUR_DIM, garbled), /did not return valid JSON/);
});

test("parseScore: a missing dimension is rejected (all rubric dims required)", () => {
  assert.throws(() => parseScore(FOUR_DIM, JSON.stringify({ dimensions: { a: 2, b: 2, c: 2 } })), /"d"/);
});

test("parseScore: non-JSON output is rejected loudly", () => {
  assert.throws(() => parseScore(FOUR_DIM, "not json at all"), /valid JSON/);
});

test("parseScore: JSON without a dimensions object is rejected", () => {
  assert.throws(() => parseScore(FOUR_DIM, JSON.stringify({ rationale: "x" })), /dimensions/);
});

test("parseScore: a missing rationale degrades to empty string (terse, not malformed)", () => {
  const score = parseScore(FOUR_DIM, JSON.stringify({ dimensions: { a: 2, b: 2, c: 2, d: 2 } }));
  assert.equal(score.rationale, "");
});

// --- the prompt embeds the rubric text, its dimension keys, and the task + subject -----------------------

test("buildJudgePrompt: the prompt embeds the rubric text, the task, and the subject", () => {
  const prompt = buildJudgePrompt(FOUR_DIM, "the task", "the subject text");
  assert.match(prompt, /FOUR-DIM RUBRIC TEXT/);
  assert.match(prompt, /the task/);
  assert.match(prompt, /the subject text/);
});

test("buildJudgePrompt: the required JSON shape lists the rubric's own dimension keys", () => {
  const prompt = buildJudgePrompt(FIVE_DIM, "t", "s");
  for (const dim of FIVE_DIM.dimensions) {
    assert.match(prompt, new RegExp(`"${dim}": 0\\|1\\|2`));
  }
});
