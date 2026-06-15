// The deterministic AC-RUNNER (ADR-001) — the substrate every metric rides on. It runs a task's hidden suite
// (every declared check) against the PRODUCED tree and emits a structured, mechanically-auditable grade. NO
// LLM anywhere in this path: zero stochasticity, so the grade contributes zero variance to AC9's C−B delta.
// The `assemble`/`reviewing` LLM judge (doc 06 §3 secondary "code-quality" soft signal) is DELIBERATELY NOT
// wired in here — it is walled off from the primary AC-pass by ADR-001.
//
// AC11 BY CONSTRUCTION: an empty/no-op produced tree makes every affirmative check fail (see check.ts), so
// `grade()` returns `passed: 0`. A missing file FAILS its check — it can never pass. That is the structural
// (not probabilistic) property ADR-001 exists to guarantee.

import type { RunRecord, TreePath } from "../types.ts";

import { runCheck } from "./check.ts";
import type { GraderFixture } from "./fixture.ts";

/**
 * The primary grade of one run — consumed by T-008 (stats reads `passed`/`total`) and T-009 (scoreboard
 * reports `perAc[]` + the R2 `met / total` count). Shape PINNED by the T-006 contract.
 */
export interface GradeResult {
  /** Number of checks that passed (the "met" in AC15's met/total). */
  passed: number;
  /** Total checks in the hidden suite (the set size — AC15's denominator). */
  total: number;
  /** Per-check outcome: independently scored, with the assertion that ran, for mechanical audit. */
  perAc: { id: string; passed: boolean; evidence: string }[];
}

/**
 * The lesson-reuse signal (AC8) — derived from OBSERVED run output, never a human opinion. Shape PINNED by
 * the T-006 contract; consumed by T-009's R3 moat section.
 */
export interface LessonSignal {
  lessonId: string;
  reused: boolean;
  /** What in the observed output proved (or failed to prove) reuse — auditable. */
  evidence: string;
}

/**
 * How a follow-up task declares the lesson the WARM (C) arm should reuse, and how to OBSERVE that reuse
 * mechanically (ADR-002 Fork A, R3 pairing). One of two observable signals (the runner needs no human call):
 *   • `lessonId` present in the run's `RunRecord.usedMemories` (the warm run reported using it), OR
 *   • `avoidedGotcha` — a token a COLD run's output would contain (the bug it falls into); the warm run
 *     "reused the lesson" iff that token is ABSENT from its produced tree. Provide `gotchaTreePath` +
 *     `gotchaPattern` so absence is observed against the produced tree, not asserted.
 */
export interface LessonDecl {
  /** The memory record id the warm run is expected to report in `usedMemories`. */
  lessonId: string;
  /**
   * Optional cold-only-gotcha probe: if set, reuse is ALSO satisfied when the gotcha is absent from the
   * produced tree (the warm run avoided the bug the cold run hits).
   */
  avoidedGotcha?: {
    /** Relative path in the produced tree to inspect for the gotcha. */
    treePath: string;
    /** Regex source whose PRESENCE in that file marks the un-avoided gotcha (so absence = avoided = reused). */
    pattern: string;
  };
}

/**
 * Grade a produced working tree against a hidden suite. Runs EVERY check (each scores independently → AC15
 * `met/total`). `producedTreeRoot` is the path to the run's produced working-tree directory; an empty/no-op
 * tree fails every affirmative check → `passed: 0` (AC11, by construction). Never reads the suite into a
 * prompt; only inspects the produced tree post-run (AC10 timing half).
 */
export function grade(producedTreeRoot: TreePath, suite: GraderFixture): GradeResult {
  const perAc = suite.checks.map((check) => runCheck(check, producedTreeRoot));
  return {
    passed: perAc.filter((r) => r.passed).length,
    total: perAc.length,
    perAc,
  };
}

/**
 * Derive the lesson-reuse signal (AC8) from a run's OBSERVED output — `usedMemories` OR a cold-only gotcha the
 * warm run avoided in its produced tree. `producedTreeRoot` is only needed when `decl.avoidedGotcha` is set.
 * No LLM, no human opinion: the verdict is a function of what the run actually emitted.
 */
export function lessonReuse(
  record: RunRecord,
  decl: LessonDecl,
  producedTreeRoot?: TreePath,
): LessonSignal {
  // Signal 1: the run reported the lesson id in used_memories.
  if (record.usedMemories.includes(decl.lessonId)) {
    return {
      lessonId: decl.lessonId,
      reused: true,
      evidence: `used_memories contains "${decl.lessonId}"`,
    };
  }

  // Signal 2 (optional): the cold-only gotcha is ABSENT from the produced tree (warm run avoided the bug).
  if (decl.avoidedGotcha !== undefined && producedTreeRoot !== undefined) {
    const probe = runCheck(
      {
        id: decl.lessonId,
        kind: "file_contains",
        path: decl.avoidedGotcha.treePath,
        pattern: decl.avoidedGotcha.pattern,
      },
      producedTreeRoot,
    );
    // The gotcha probe PASSES when the bug pattern is PRESENT; reuse means it is ABSENT → invert.
    if (!probe.passed) {
      return {
        lessonId: decl.lessonId,
        reused: true,
        evidence: `gotcha avoided: /${decl.avoidedGotcha.pattern}/ absent from ${decl.avoidedGotcha.treePath}`,
      };
    }
    return {
      lessonId: decl.lessonId,
      reused: false,
      evidence: `not in used_memories; gotcha PRESENT: /${decl.avoidedGotcha.pattern}/ in ${decl.avoidedGotcha.treePath}`,
    };
  }

  return {
    lessonId: decl.lessonId,
    reused: false,
    evidence: `used_memories does not contain "${decl.lessonId}"`,
  };
}
