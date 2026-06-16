// Tests for the decision-quality probe driver + artifact emitter + headless command (design §5). ZERO API
// spend: every case drives the probe through an INJECTED judge fn keyed on the artifact text embedded in the
// prompt — no `claude -p` ever runs. The forced cases prove the GATED ORDER (design §3/§5): a noisy A/A judge
// aborts BEFORE scoring, a judge that can't separate planted GOLD/POOR aborts BEFORE scoring, and only a stable
// + discriminating judge reaches the input scores. The planted fixtures are loaded from `fixtures/quality/`.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { runQualityProbe, type PlantedFixtures, type QualityInput } from "../src/quality/probe.ts";
import { loadPlantedFixtures } from "../src/quality/command.ts";
import type { JudgeFn } from "../src/quality/judge.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "fixtures", "quality");

/** The real planted fixtures the probe's positive control judges. */
const PLANTED: PlantedFixtures = loadPlantedFixtures(FIXTURES_DIR);

/** Two input artifacts to score (distinct text so the keyed judge can give each its own score). */
const INPUTS: QualityInput[] = [
  { taskId: "input-a", taskPrompt: PLANTED.taskPrompt, artifactText: "INPUT_A artifact body" },
  { taskId: "input-b", taskPrompt: PLANTED.taskPrompt, artifactText: "INPUT_B artifact body" },
];

/** A canned verdict whose five dimensions each take `n` (0/1/2) ⇒ overall = (5n)/10. */
function dimsAll(n: number): string {
  return JSON.stringify({
    dimensions: { forkSurfacing: n, decisionSoundness: n, accountability: n, scope: n, coherence: n },
    rationale: "canned",
  });
}

/**
 * A stable + discriminating judge: keyed on a phrase UNIQUE to each planted artifact (the two specs share a
 * heading, so a prefix match would alias them — these markers appear in exactly one).
 *   - the GOLD spec  → all-2 (overall 1.0, high);
 *   - the POOR spec  → all-0 (overall 0.0, low);
 *   - any input      → all-1 (overall 0.5, mid).
 * Deterministic per artifact ⇒ the A/A repeats on GOLD all return 1.0 (zero spread, stable).
 */
// Markers unique to each artifact's BODY — and absent from the embedded rubric text (so they fire on the
// artifact, not on the prompt scaffolding). The two specs share a heading, so a prefix match would alias them.
const GOLD_MARKER = "first-write-wins";
const POOR_MARKER = "standard, well-understood";
// Guard the markers' invariants up front: each must appear in exactly its own spec, so a fixture edit that drops
// or aliases them fails HERE, not as an inscrutable abort later.
assert.ok(PLANTED.goldText.includes(GOLD_MARKER) && !PLANTED.poorText.includes(GOLD_MARKER), "gold marker is unique");
assert.ok(PLANTED.poorText.includes(POOR_MARKER) && !PLANTED.goldText.includes(POOR_MARKER), "poor marker is unique");
const goodJudge: JudgeFn = (prompt) => {
  if (prompt.includes(GOLD_MARKER)) return dimsAll(2);
  if (prompt.includes(POOR_MARKER)) return dimsAll(0);
  return dimsAll(1);
};

/** A fresh temp out path so no test clobbers another's artifact. */
function outPath(): string {
  return join(mkdtempSync(join(tmpdir(), "selfeval-quality-")), "decision-quality.json");
}

// --- the happy path: a stable, discriminating judge passes both gates and scores the inputs ------------

test("runQualityProbe: a stable + discriminating judge passes the gates and emits scored inputs", async () => {
  const out = outPath();
  const result = await runQualityProbe({
    artifacts: INPUTS,
    planted: PLANTED,
    judge: goodJudge,
    outPath: out,
  });

  assert.equal(result.artifact.condition, "scored");
  assert.equal(result.artifact.abortVerdict, undefined);
  // Both inputs were scored (the gates did not short-circuit), each at the mid 0.5 overall.
  assert.equal(result.artifact.scores?.length, INPUTS.length);
  assert.deepEqual(
    result.artifact.scores?.map((s) => s.taskId),
    ["input-a", "input-b"],
  );
  assert.equal(result.artifact.scores?.every((s) => s.score.overall === 0.5), true);
  assert.equal(result.artifact.overallMean, 0.5);
  // The control readouts prove the gates passed: GOLD high, POOR low, A/A stdev 0.
  assert.equal(result.artifact.controls?.goldOverall, 1);
  assert.equal(result.artifact.controls?.poorOverall, 0);
  assert.ok((result.artifact.controls?.aaStdev ?? 1) < 1e-9, "stable A/A on GOLD ⇒ ~zero spread");
});

test("runQualityProbe: the scored artifact is written to disk and matches the returned artifact", async () => {
  const out = outPath();
  const result = await runQualityProbe({ artifacts: INPUTS, planted: PLANTED, judge: goodJudge, outPath: out });
  const onDisk = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(onDisk, result.artifact);
});

test("runQualityProbe: each scored input carries the full five-dimension breakdown", async () => {
  const out = outPath();
  const result = await runQualityProbe({ artifacts: INPUTS, planted: PLANTED, judge: goodJudge, outPath: out });
  const first = result.artifact.scores?.[0];
  assert.deepEqual(Object.keys(first!.score.dimensions), [
    "forkSurfacing",
    "decisionSoundness",
    "accountability",
    "scope",
    "coherence",
  ]);
});

// --- gate (a): a noisy A/A judge aborts BEFORE any input is scored -------------------------------------

test("runQualityProbe: a noisy judge (scatter on the same GOLD artifact) aborts with judge-measures-noise", async () => {
  // The A/A repeats judge the SAME GOLD text; this judge returns a different overall each call (a moving
  // counter) ⇒ a wide spread ⇒ the negative control fires before the inputs are ever judged.
  let call = 0;
  const noisyOveralls = [2, 0, 2]; // dims-all 2→1.0, 0→0.0, 2→1.0 : stdev ≈ 0.47, way over tolerance
  const noisyJudge: JudgeFn = () => dimsAll(noisyOveralls[call++ % noisyOveralls.length]!);

  const out = outPath();
  const result = await runQualityProbe({ artifacts: INPUTS, planted: PLANTED, judge: noisyJudge, outPath: out });

  assert.equal(result.artifact.condition, "aborted");
  assert.equal(result.artifact.abortVerdict, "judge-measures-noise");
  assert.equal(result.artifact.scores, undefined, "no inputs are scored once the A/A gate fires");
  assert.equal(result.artifact.controls, undefined);
});

// --- gate (b): a judge that can't separate planted GOLD from POOR aborts BEFORE any input is scored ----

test("runQualityProbe: a judge that scores everything the same aborts with judge-cannot-discriminate", async () => {
  // Stable (A/A passes — same input, same score) but FLAT: GOLD and POOR both land at 0.5, so the positive
  // control cannot separate them and the run aborts before the inputs are judged.
  const flatJudge: JudgeFn = () => dimsAll(1);

  const out = outPath();
  const result = await runQualityProbe({ artifacts: INPUTS, planted: PLANTED, judge: flatJudge, outPath: out });

  assert.equal(result.artifact.condition, "aborted");
  assert.equal(result.artifact.abortVerdict, "judge-cannot-discriminate");
  assert.equal(result.artifact.scores, undefined, "no inputs are scored once the discrimination gate fires");
});

test("runQualityProbe: the aborted artifact is written to disk with no scores", async () => {
  const out = outPath();
  const flatJudge: JudgeFn = () => dimsAll(1);
  await runQualityProbe({ artifacts: INPUTS, planted: PLANTED, judge: flatJudge, outPath: out });
  const onDisk = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(onDisk.condition, "aborted");
  assert.equal(onDisk.scores, undefined);
});

// --- the planted fixtures themselves are well-formed (the positive control's ground truth) -------------

test("planted fixtures load and the GOLD/POOR specs are distinct, comparable-length artifacts", () => {
  assert.ok(PLANTED.taskPrompt.length > 0, "task.txt is non-empty");
  assert.ok(PLANTED.goldText.length > 0 && PLANTED.poorText.length > 0, "both specs are non-empty");
  assert.notEqual(PLANTED.goldText, PLANTED.poorText, "gold and poor are different artifacts");
  // Length must not be the discriminator — the two specs are within ~30% of each other.
  const ratio = PLANTED.goldText.length / PLANTED.poorText.length;
  assert.ok(ratio > 0.7 && ratio < 1.43, `gold/poor length ratio ${ratio} should be near 1`);
});
