// The shared JUDGE ENGINE (ADR-002) — ONE rubric-parameterized "LLM-judge-a-rubric-with-controls" kernel,
// lifting the spawn seam from `quality/judge.ts` (its original home) UP into the shared `judge/` layer and
// generalizing `quality`'s `judgeArtifact` / `outcome-judge`'s `judgeOutcome` into a single `judgeWithRubric`
// that takes a {@link Rubric} value. It mirrors `io/live.ts`'s INJECTABLE-spawn discipline: the real judge shells
// out to `claude -p --output-format json` with a pinned model, but the spawn is INJECTED via {@link JudgeFn}, so
// tests drive CANNED scores at ZERO API spend (the same seam that lets the capture run offline).
//
// This module owns ONLY the judging call + the response parse/validation; the rubric VALUE lives in rubric.ts and
// the gating controls in controls.ts. The judge is stateless — one rubric + one subject in, one validated score
// out — so a probe calls it identically for its A/A repeats, its golden/broken discrimination trees, and each
// real subject. `overall` is ALWAYS recomputed as `dimensionSum / rubric.max` from the validated dimensions; the
// model's own `overall`, if any, is IGNORED so a model that miscomputes or flatters cannot skew the score.

import { spawnSync } from "node:child_process";

import { overallFromDimensions, type Rubric, type RubricDimensions } from "./rubric.ts";

/** The model the judge pins for every call. A generic default; the caller may override it (ADR-002). */
export const DEFAULT_JUDGE_MODEL = "claude-opus-4-8[1m]";

/** The injectable judging seam: prompt in, raw model-JSON text out (the model's rubric verdict as a JSON string). */
export type JudgeFn = (prompt: string, model: string) => string;

/**
 * The structured score the engine returns for one judged subject (ADR-002). `overall` is `dimensionSum / max`
 * (0..1), recomputed from `dimensions` — never trusted from the model.
 */
export interface Score {
  /** The per-dimension 0/1/2 scores, keyed by the rubric's dimension names. */
  dimensions: RubricDimensions;
  /** The normalized overall, `dimensionSum / rubric.max` (0..1) — recomputed from `dimensions`. */
  overall: number;
  /** The judge's free-text justification for the scores (empty string if the model omitted it). */
  rationale: string;
}

/** Alias for {@link Score} — the rubric-scored verdict the engine produces (exposed for downstream clarity). */
export type RubricScore = Score;

/** Options for one judge call. The `judge` fn is INJECTED in tests (canned scores, zero API). */
export interface JudgeOptions {
  /** The model id to pin (defaults to {@link DEFAULT_JUDGE_MODEL}); the caller discovers it from env/config. */
  model?: string;
  /**
   * The raw-judging seam: takes the assembled prompt, returns the model's RAW JSON text (the `result` field of
   * `claude -p --output-format json`). Injected in tests to feed canned JSON with no `claude` spawn; defaults to
   * {@link realJudgeFn} (a real `claude -p` call). Mirrors `io/live.ts`'s `SpawnFn`.
   */
  judge?: JudgeFn;
}

/**
 * The production judge: invoke `claude -p --output-format json` with the rubric prompt and return the model's
 * `result` text (the JSON the model was asked to emit). This is the ONLY function here that spends API; it is
 * never exercised by the tests (they inject {@link JudgeOptions.judge}). `spawnSync` keeps the judge a simple
 * blocking call — one subject, one verdict — unlike the streaming capture in `io/live.ts`.
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
 * Build the judge prompt: the rubric, the task it answers, the subject under test, and the strict JSON shape to
 * return. The task and subject are clearly delimited so the model cannot confuse instructions with content; the
 * required `dimensions` keys are derived FROM the rubric, so a new rubric needs no prompt-template edit here.
 */
export function buildJudgePrompt(rubric: Rubric, taskPrompt: string, subjectText: string): string {
  const dimensionKeys = rubric.dimensions.map((d) => `    "${d}": 0|1|2`).join(",\n");
  return `You are an exacting senior engineer grading the SUBJECT below against the rubric. Grade strictly.

${rubric.promptText}

=== TASK THE SUBJECT ANSWERS ===
${taskPrompt}

=== SUBJECT UNDER TEST ===
${subjectText}

Return ONLY a JSON object, no prose around it, of exactly this shape:
{
  "dimensions": {
${dimensionKeys}
  },
  "rationale": "<one-paragraph justification grounded in the subject's content>"
}`;
}

/**
 * Coerce a value to an integer dimension score in {0,1,2}, throwing if it is out of range. Range validation is
 * the judge's contract (ADR-002): a model that returns 3, -1, or a non-integer for a dimension is a malformed
 * verdict, surfaced loudly rather than silently clamped (a clamp would hide a broken judge).
 */
function validatedDimension(name: string, raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 2) {
    throw new Error(`judge: dimension "${name}" must be an integer 0..2, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Extract a JSON object from the model's raw answer, tolerating the decoration a real `claude -p` routinely adds:
 * a ```json …``` markdown fence, or a prose preamble/postamble around the object. Tries, in order: the whole string,
 * the contents of a fenced block, then the outermost `{ … }` brace span. Returns the first that parses, or
 * `undefined` when none do (the caller then throws the loud "did not return valid JSON"). A bare-JSON answer (the
 * test path) parses on the first try, so this is purely additive robustness — never a behavior change for clean input.
 */
function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1] !== undefined) candidates.push(fence[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/**
 * Parse the model's raw JSON into a validated {@link Score} for the given rubric. Reads exactly the rubric's
 * dimensions, range-checks each (0..2 integer), recomputes `overall = sum / rubric.max` from them (the model's own
 * `overall`, if any, is IGNORED — the normalization is the harness's, not the model's), and carries the rationale
 * through (empty string if absent — a missing rationale is not a malformed verdict, just a terse one).
 */
export function parseScore(rubric: Rubric, raw: string): Score {
  const parsed = extractJsonObject(raw);
  if (parsed === undefined) {
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
  const dimensions: RubricDimensions = {};
  for (const name of rubric.dimensions) {
    dimensions[name] = validatedDimension(name, rawDims[name]);
  }
  return {
    dimensions,
    overall: overallFromDimensions(rubric, dimensions),
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
  };
}

/**
 * Judge ONE subject against a {@link Rubric} (ADR-002): build the rubric prompt from the task + subject text, call
 * the (injected or real) judge fn, and parse + validate the response into a {@link Score}. Async to match the
 * probe's awaited flow and the live `claude` round-trip, even though the injected test path resolves
 * synchronously.
 *
 * `opts.judge` is injected only in tests (canned JSON, zero API); production uses the real `claude -p` call.
 */
export async function judgeWithRubric(
  rubric: Rubric,
  taskPrompt: string,
  subjectText: string,
  opts: JudgeOptions = {},
): Promise<Score> {
  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  const judge = opts.judge ?? realJudgeFn;
  const prompt = buildJudgePrompt(rubric, taskPrompt, subjectText);
  const raw = judge(prompt, model);
  return parseScore(rubric, raw);
}
