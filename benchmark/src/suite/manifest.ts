// The task.yaml MANIFEST schema (ADR-002 Fork A) — the harness's only public authoring surface. One
// `task.yaml` per fixture dir DECLARES a benchmark task: its id, regime, which arms may run it, the prompt
// (inline or by file), and — for R3 — how it pairs with its teacher/follow-up and the lesson to reuse.
//
// This module owns ONLY the parse-and-validate of one manifest (pure, no directory I/O — loader.ts walks the
// tree and locates grader/). It parses with the `yaml` workspace dep and hard-codes NO repo specifics: the
// manifest *declares* what a run should produce; the fixture author fills it in (CLAUDE.md generic constraint).
//
// `LessonDecl` is NOT redeclared here — it is owned by the grader (../grader/runner.ts, T-006) as the input to
// `lessonReuse`. The R3 follow-up's `lesson` field IS a `LessonDecl`, imported verbatim (CLAUDE.md: never
// duplicate a contract type).

import { parse as parseYaml } from "yaml";

import type { Regime } from "../types.ts";
import type { LessonDecl } from "../grader/runner.ts";

export type { LessonDecl };

/** The arms a task is eligible to run under (Spec §4: A=plain, B=cold, C=warm). */
export type ArmEligibility = ("A" | "B" | "C")[];

/**
 * A parsed task.yaml manifest (ADR-002 Fork A). Exactly one of `prompt` | `promptFile` is present (the
 * prompt handed to `claude -p`; the hidden suite is NEVER here — AC10). The optional fields carry R3 pairing:
 *   • `pair` — the id of the OTHER half of an R3 teacher↔follow-up pair (cross-reference by id).
 *   • `deps` — task ids that must run before this one (ordering; e.g. teacher before follow-up).
 *   • `lesson` — present ONLY on the R3 follow-up: the LessonDecl the warm (C) arm is expected to reuse (AC8).
 */
export interface TaskManifest {
  /** Unique task id; also the fixture directory name (loader resolves pairs/deps by this id). */
  id: string;
  regime: Regime;
  /** Which arms may run this task (Spec §4). */
  armEligibility: ArmEligibility;
  /** Inline prompt; mutually exclusive with `promptFile`. */
  prompt?: string;
  /** Prompt loaded from a sibling file (relative to the fixture dir); mutually exclusive with `prompt`. */
  promptFile?: string;
  /** Task ids that must run before this one (ordering seam). */
  deps?: string[];
  /** The id of the paired task (R3 teacher↔follow-up cross-reference). */
  pair?: string;
  /** The lesson the warm arm should reuse — present only on the R3 follow-up (AC8). */
  lesson?: LessonDecl;
}

const REGIMES: ReadonlySet<string> = new Set<Regime>(["R0", "R1", "R1prime", "R2", "R3"]);
const ARMS: ReadonlySet<string> = new Set(["A", "B", "C"]);

/**
 * Parse + validate one `task.yaml` body into a `TaskManifest`. `source` is only used to make errors point at
 * the offending file. THROWS on any structural violation — a malformed manifest is a fixture bug to surface
 * loudly (the loader's AC14 enumeration depends on every manifest being well-formed), never to default away.
 */
export function parseManifest(yamlText: string, source: string): TaskManifest {
  const raw = parseYaml(yamlText) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: task.yaml must be a YAML mapping, got ${describe(raw)}`);
  }
  const obj = raw as Record<string, unknown>;

  const id = requireString(obj.id, "id", source);

  const regime = requireString(obj.regime, "regime", source);
  if (!REGIMES.has(regime)) {
    throw new Error(`${source}: regime "${regime}" is not one of R0|R1|R1prime|R2|R3`);
  }

  const armEligibility = parseArmEligibility(obj["armEligibility"] ?? obj["arm-eligibility"], source);

  const hasPrompt = typeof obj.prompt === "string" && obj.prompt.length > 0;
  const hasPromptFile = typeof obj.promptFile === "string" && obj.promptFile.length > 0;
  if (hasPrompt === hasPromptFile) {
    throw new Error(`${source}: exactly one of \`prompt\` | \`promptFile\` is required`);
  }

  const manifest: TaskManifest = {
    id,
    regime: regime as Regime,
    armEligibility,
  };
  if (hasPrompt) manifest.prompt = obj.prompt as string;
  if (hasPromptFile) manifest.promptFile = obj.promptFile as string;

  const deps = parseStringArray(obj.deps, "deps", source);
  if (deps !== undefined) manifest.deps = deps;

  if (obj.pair !== undefined) manifest.pair = requireString(obj.pair, "pair", source);

  if (obj.lesson !== undefined) manifest.lesson = parseLesson(obj.lesson, source);

  return manifest;
}

function parseArmEligibility(value: unknown, source: string): ArmEligibility {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${source}: armEligibility must be a non-empty array of arms (A|B|C)`);
  }
  const out: ArmEligibility = [];
  for (const a of value) {
    if (typeof a !== "string" || !ARMS.has(a)) {
      throw new Error(`${source}: armEligibility entry "${String(a)}" is not one of A|B|C`);
    }
    out.push(a as "A" | "B" | "C");
  }
  return out;
}

function parseStringArray(value: unknown, field: string, source: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${source}: \`${field}\` must be an array of strings`);
  return value.map((v) => requireString(v, `${field}[]`, source));
}

function parseLesson(value: unknown, source: string): LessonDecl {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: \`lesson\` must be a mapping (a LessonDecl)`);
  }
  const obj = value as Record<string, unknown>;
  const lessonId = requireString(obj.lessonId, "lesson.lessonId", source);
  const decl: LessonDecl = { lessonId };
  if (obj.avoidedGotcha !== undefined) {
    const g = obj.avoidedGotcha;
    if (g === null || typeof g !== "object" || Array.isArray(g)) {
      throw new Error(`${source}: \`lesson.avoidedGotcha\` must be a mapping`);
    }
    const gObj = g as Record<string, unknown>;
    decl.avoidedGotcha = {
      treePath: requireString(gObj.treePath, "lesson.avoidedGotcha.treePath", source),
      pattern: requireString(gObj.pattern, "lesson.avoidedGotcha.pattern", source),
    };
  }
  return decl;
}

function requireString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source}: \`${field}\` must be a non-empty string, got ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
