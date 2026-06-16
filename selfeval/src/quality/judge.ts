// The decision-quality JUDGE (design §2) — an LLM call that scores one conductor-produced artifact against the
// rubric, returning a structured `QualityScore`. It mirrors `io/live.ts`'s INJECTABLE-spawn discipline: the real
// judge shells out to `claude -p --output-format json` with a pinned model, but the spawn is injected, so tests
// drive CANNED scores at ZERO API spend (the same seam that lets the routing capture run offline).
//
// This module owns ONLY the judging call + the response parse/validation. The rubric (the prompt text + the
// 0/1/2 vocabulary) lives in rubric.ts; the controls that GATE the judge live in control.ts. The judge here is
// stateless — one artifact in, one validated score out — so the probe can call it for the A/A repeats, the
// planted fixtures, and each real artifact identically.

import { spawnSync } from "node:child_process";

import {
  QUALITY_DIMENSIONS,
  RUBRIC_TEXT,
  overallFromDimensions,
  type QualityDimension,
  type QualityDimensions,
} from "./rubric.ts";

/** The model the judge pins for every call. A generic default; the command may override it (design §2). */
export const DEFAULT_JUDGE_MODEL = "claude-opus-4-8[1m]";

/** The structured score the judge returns for one artifact (design §2). `overall` is `sum/10` (0..1). */
export interface QualityScore {
  /** The per-dimension 0/1/2 scores. */
  dimensions: QualityDimensions;
  /** The normalized overall, `sum / 10` (0..1) — recomputed from `dimensions`, never trusted from the model. */
  overall: number;
  /** The judge's free-text justification for the scores. */
  rationale: string;
}

/** Options for one judge call. The `judge` fn is INJECTED in tests (canned scores, zero API). */
export interface JudgeOptions {
  /** The model id to pin (defaults to {@link DEFAULT_JUDGE_MODEL}); the command discovers it from env/config. */
  model?: string;
  /**
   * The raw-judging seam: takes the assembled prompt, returns the model's RAW JSON text (the `result` field of
   * `claude -p --output-format json`). Injected in tests to feed canned JSON with no `claude` spawn; defaults to
   * {@link realJudgeFn} (a real `claude -p` call). Mirrors `io/live.ts`'s `SpawnFn`.
   */
  judge?: JudgeFn;
}

/** The injectable judging seam: prompt in, raw model-JSON text out (the model's rubric verdict as a JSON string). */
export type JudgeFn = (prompt: string, model: string) => string;

/**
 * The production judge: invoke `claude -p --output-format json` with the rubric prompt and return the model's
 * `result` text (the JSON the model was asked to emit). This is the ONLY function here that spends API; it is
 * never exercised by the tests (they inject {@link JudgeOptions.judge}). `spawnSync` keeps the judge a simple
 * blocking call — one artifact, one verdict — unlike the streaming capture in `io/live.ts`.
 */
export const realJudgeFn: JudgeFn = (prompt, model) => {
  const proc = spawnSync("claude", ["-p", prompt, "--output-format", "json", "--model", model], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    throw new Error(`judge: claude -p exited ${proc.status}: ${proc.stderr ?? ""}`);
  }
  // `--output-format json` wraps the model's answer in an envelope `{ result: "<the model's text>", ... }`.
  const envelope = JSON.parse(proc.stdout) as { result?: unknown };
  if (typeof envelope.result !== "string") {
    throw new Error("judge: claude -p json envelope missing a string `result` field");
  }
  return envelope.result;
};

/**
 * Build the judge prompt: the rubric, the task it answers, the artifact under test, and the strict JSON shape to
 * return. The artifact and task are clearly delimited so the model cannot confuse instructions with content.
 */
export function buildJudgePrompt(taskPrompt: string, artifactText: string): string {
  return `You are an exacting senior engineer grading the QUALITY of a spec/plan artifact a routing system
produced for a task. Grade strictly against the rubric below.

${RUBRIC_TEXT}

=== TASK THE ARTIFACT ANSWERS ===
${taskPrompt}

=== ARTIFACT UNDER TEST ===
${artifactText}

Return ONLY a JSON object, no prose around it, of exactly this shape:
{
  "dimensions": {
    "forkSurfacing": 0|1|2,
    "decisionSoundness": 0|1|2,
    "accountability": 0|1|2,
    "scope": 0|1|2,
    "coherence": 0|1|2
  },
  "rationale": "<one-paragraph justification grounded in the artifact's content>"
}`;
}

/**
 * Coerce a value to an integer dimension score in {0,1,2}, throwing if it is out of range. Range validation is
 * the judge's contract (design §2): a model that returns 3, -1, or a non-integer for a dimension is a malformed
 * verdict, surfaced loudly rather than silently clamped (a clamp would hide a broken judge).
 */
function validatedDimension(name: QualityDimension, raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 2) {
    throw new Error(`judge: dimension "${name}" must be an integer 0..2, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Parse the model's raw JSON into a validated {@link QualityScore}. Reads exactly the five rubric dimensions,
 * range-checks each (0..2 integer), recomputes `overall = sum/10` from them (the model's own `overall`, if any,
 * is IGNORED — the normalization is the harness's, not the model's, so a model that miscomputes cannot skew the
 * score), and carries the rationale through (empty string if absent — a missing rationale is not a malformed
 * verdict, just a terse one).
 */
export function parseQualityScore(raw: string): QualityScore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("judge: model did not return valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("judge: model JSON is not an object");
  }
  const obj = parsed as { dimensions?: unknown; rationale?: unknown };
  if (typeof obj.dimensions !== "object" || obj.dimensions === null) {
    throw new Error("judge: model JSON is missing a `dimensions` object");
  }
  const rawDims = obj.dimensions as Record<string, unknown>;
  const dimensions = {} as QualityDimensions;
  for (const name of QUALITY_DIMENSIONS) {
    dimensions[name] = validatedDimension(name, rawDims[name]);
  }
  return {
    dimensions,
    overall: overallFromDimensions(dimensions),
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
  };
}

/**
 * Judge ONE artifact (design §2): build the rubric prompt, call the (injected or real) judge fn, and parse +
 * validate the response into a {@link QualityScore}. Async to match the probe's awaited flow and the live
 * `claude` round-trip, even though the injected test path resolves synchronously.
 *
 * `opts.judge` is injected only in tests (canned JSON, zero API); production uses the real `claude -p` call.
 */
export async function judgeArtifact(
  taskPrompt: string,
  artifactText: string,
  opts: JudgeOptions = {},
): Promise<QualityScore> {
  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  const judge = opts.judge ?? realJudgeFn;
  const prompt = buildJudgePrompt(taskPrompt, artifactText);
  const raw = judge(prompt, model);
  return parseQualityScore(raw);
}
