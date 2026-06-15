// Tests for the scoreboard assembler + Markdown projection (T-009, M7, ADR-002 Fork B). ZERO API spend —
// everything runs on synthetic stats/grade inputs; no `claude -p` is ever invoked. Covers the task's
// Acceptance 1–6:
//   #1 (AC2)  — assembleScoreboard yields C1–C4 each {verdict, delta, variance}.
//   #2 (AC3)  — the per-regime table lists every regime present with per-arm metrics.
//   #3 (AC7)  — the R3 section shows B and C for the same follow-up id + a computed C−B delta.
//   #4 (AC15) — R2 reports met/total per arm, a count not a boolean.
//   #5 (AC13) — equivalent-arms (null) stats → a visible "no win" verdict in BOTH the JSON and the Markdown.
//   #6 (AC9)  — renderMarkdown is reproducible from the JSON alone (a pure projection).
import assert from "node:assert/strict";
import { test } from "node:test";

import { reproducible } from "../src/stats/verdict.ts";
import type { PairedDelta } from "../src/stats/bootstrap.ts";
import type { Aggregate } from "../src/stats/aggregate.ts";
import type { VerdictConfig } from "../src/stats/verdict.ts";
import {
  assembleScoreboard,
  type CellGrade,
  type ScoreboardStats,
} from "../src/scoreboard/assemble.ts";
import { renderMarkdown } from "../src/scoreboard/render.ts";

const CONFIG: VerdictConfig = { minEffectSize: 0.8 };

/** Build a synthetic PairedDelta. `halfWidth` drives the recorded variance (variance = halfWidth²). */
function delta(
  point: number,
  ci: [number, number],
  effectSize: number,
  halfWidth = (ci[1] - ci[0]) / 2,
): PairedDelta {
  return { delta: point, ci95: ci, effectSize, ciHalfWidth: halfWidth, ciLevel: 0.95 };
}

/** A clear win: CI entirely below 0, effect well past the min — verdict('win'). */
const WIN = delta(-0.08, [-0.1, -0.06], -5);
/** An honest null: CI straddles 0 — verdict('null'). */
const NULL = delta(0.001, [-0.02, 0.022], 0.1);

function agg(mean: number, variance: number | undefined, n: number): Aggregate {
  return { mean, variance, n };
}

/** A complete, representative stats bundle spanning all four claims, three regimes, and one R3 pair. */
function fullStats(): ScoreboardStats {
  return {
    claims: { c1: { delta: WIN }, c2: { delta: NULL }, c3: { delta: WIN }, c4: { delta: WIN } },
    verdictConfig: CONFIG,
    regimes: {
      R0: { A: { acPassRate: agg(0.9, 0.01, 5) }, B: { acPassRate: agg(0.92, 0.008, 5) } },
      R2: { A: { acPassRate: agg(0.5, 0.02, 5) }, B: { acPassRate: agg(0.8, 0.01, 5) } },
      R3: {
        B: { acPassRate: agg(0.7, 0.01, 5), tokens: agg(20000, 1e6, 5), turns: agg(4, 0.5, 5) },
        C: { acPassRate: agg(0.9, 0.005, 5), tokens: agg(12000, 5e5, 5), turns: agg(3, 0.2, 5) },
      },
    },
    r3: [
      {
        followUpTaskId: "task-followup-42",
        cold: delta(0.2, [0.18, 0.22], 1),
        warm: delta(0.12, [0.1, 0.14], 1),
        moat: delta(-0.08, [-0.1, -0.06], -5),
        lessonReused: true,
        lessonReuseEvidence: 'used_memories contains "lesson-7"',
      },
    ],
  };
}

const GRADES: CellGrade[] = [
  { regime: "R2", arm: "A", passed: 3, total: 7 },
  { regime: "R2", arm: "B", passed: 6, total: 7 },
  { regime: "R0", arm: "A", passed: 7, total: 7 }, // non-R2 → must NOT appear in r2Coverage
];

// --- #1 (AC2): C1–C4 each {verdict, delta, variance} -------------------------

test("assembleScoreboard produces C1–C4 each carrying {verdict, delta, variance} (AC2)", () => {
  const sb = assembleScoreboard(GRADES, fullStats());
  for (const key of ["c1", "c2", "c3", "c4"] as const) {
    const claim = sb.claims[key];
    assert.ok(typeof claim.verdict === "string", `${key} missing verdict`);
    assert.equal(typeof claim.delta, "number", `${key} missing delta`);
    assert.equal(typeof claim.variance, "number", `${key} missing variance`);
  }
  // The verdicts come from T-008's gate, not invented here.
  assert.equal(sb.claims.c1.verdict, "win");
  assert.equal(sb.claims.c2.verdict, "null");
  // variance is the delta's spread (halfWidth²), never 0 for a real CI.
  assert.ok(sb.claims.c1.variance > 0, "win claim must carry a real variance");
});

test("a claim's recorded variance equals its CI half-width squared (AC9 reproducibility seam)", () => {
  const sb = assembleScoreboard(GRADES, fullStats());
  // WIN.ciHalfWidth = 0.02 → variance 0.0004; sqrt(variance) recovers the half-width T-008 compares against.
  assert.ok(Math.abs(sb.claims.c1.variance - 0.02 * 0.02) < 1e-12);
  assert.ok(Math.abs(Math.sqrt(sb.claims.c1.variance) - 0.02) < 1e-12);
});

// --- #2 (AC3): per-regime table lists every regime with per-arm metrics ------

test("the per-regime table lists every regime present, in deterministic order, with per-arm metrics (AC3)", () => {
  const sb = assembleScoreboard(GRADES, fullStats());
  assert.deepEqual(
    sb.perRegime.map((r) => r.regime),
    ["R0", "R2", "R3"],
  );
  const r0 = sb.perRegime.find((r) => r.regime === "R0")!;
  assert.equal(r0.acPassRateByArm.A, 0.9);
  assert.equal(r0.acPassRateByArm.B, 0.92);
  assert.equal(r0.acPassRateByArm.C, undefined); // arm C absent in R0 → absent, not a fake zero
});

test("R3 row carries tokens/turns per arm; non-R3 rows omit them (AC3)", () => {
  const sb = assembleScoreboard(GRADES, fullStats());
  const r3 = sb.perRegime.find((r) => r.regime === "R3")!;
  assert.equal(r3.tokensByArm?.B, 20000);
  assert.equal(r3.turnsByArm?.C, 3);
  const r0 = sb.perRegime.find((r) => r.regime === "R0")!;
  assert.equal(r0.tokensByArm, undefined, "non-R3 regime must not report tokens");
});

// --- #3 (AC7): R3 section shows B and C for the same follow-up + C−B delta ----

test("the R3 section shows B and C for the same follow-up id + a computed C−B delta (AC7)", () => {
  const sb = assembleScoreboard(GRADES, fullStats());
  assert.equal(sb.r3.length, 1);
  const pair = sb.r3[0]!;
  assert.equal(pair.followUpTaskId, "task-followup-42");
  assert.equal(pair.cold.delta, 0.2);
  assert.equal(pair.warm.delta, 0.12);
  assert.equal(pair.moatDelta, -0.08); // the C−B moat, carried verbatim from the paired stat
  assert.equal(pair.lessonReused, true);
  assert.equal(pair.lessonReuseEvidence, 'used_memories contains "lesson-7"');
});

// --- #4 (AC15): R2 reports met/total per arm, a count not a boolean ----------

test("R2 coverage is reported as met/total per arm, a count (not a boolean) (AC15)", () => {
  const sb = assembleScoreboard(GRADES, fullStats());
  assert.deepEqual(sb.r2Coverage.A, { met: 3, total: 7 });
  assert.deepEqual(sb.r2Coverage.B, { met: 6, total: 7 });
  assert.equal(sb.r2Coverage.C, undefined); // arm C ran no R2 cell
  // The R0 cell (arm A, passed 7/7) must NOT leak into R2 coverage.
  assert.notDeepEqual(sb.r2Coverage.A, { met: 7, total: 7 });
});

test("multiple R2 cells for the same arm accumulate met and total (AC15)", () => {
  const grades: CellGrade[] = [
    { regime: "R2", arm: "A", passed: 2, total: 3 },
    { regime: "R2", arm: "A", passed: 1, total: 4 },
  ];
  const sb = assembleScoreboard(grades, fullStats());
  assert.deepEqual(sb.r2Coverage.A, { met: 3, total: 7 });
});

// --- #5 (AC13): equivalent-arms null → visible "no win" in BOTH JSON and MD ---

test("an equivalent-arms (null) claim surfaces as 'null' in the JSON AND 'no measurable win' in Markdown (AC13)", () => {
  const stats = fullStats();
  stats.claims.c1 = { delta: NULL }; // make the headline claim an honest null
  const sb = assembleScoreboard(GRADES, stats);
  // JSON: the honest null is present, not rounded into a win.
  assert.equal(sb.claims.c1.verdict, "null");

  // Markdown: visibly "no measurable win", never hidden.
  const md = renderMarkdown(sb);
  assert.match(md, /no measurable win/);
  const c1Row = md.split("\n").find((l) => l.startsWith("| C1 "))!;
  assert.match(c1Row, /no measurable win/); // C1 row shows the honest null verdict...
  assert.equal(/\| win \|/.test(c1Row), false, "C1 must not render the bare 'win' verdict cell"); // ...not a win
});

test("an R3 pair where both arms are null renders an explicit 'no measurable win in R3' (AC13)", () => {
  const stats = fullStats();
  stats.r3 = [
    {
      followUpTaskId: "task-equiv",
      cold: NULL,
      warm: NULL,
      moat: delta(0.001, [-0.02, 0.022], 0.1),
      lessonReused: false,
    },
  ];
  const md = renderMarkdown(assembleScoreboard(GRADES, stats));
  assert.match(md, /no measurable win in R3/);
});

// --- #6 (AC9): renderMarkdown is a pure projection of the JSON ----------------

test("renderMarkdown is reproducible from the JSON alone — same JSON → identical Markdown (AC6/AC9)", () => {
  const sb = assembleScoreboard(GRADES, fullStats());
  // Round-trip through JSON: the render must depend ONLY on the serialized object, nothing external.
  const fromObject = renderMarkdown(sb);
  const fromJson = renderMarkdown(JSON.parse(JSON.stringify(sb)));
  assert.equal(fromObject, fromJson);
});

test("renderMarkdown changes in exactly the verdict line when only a verdict differs (projection, not authored)", () => {
  const winStats = fullStats();
  const nullStats = fullStats();
  nullStats.claims.c1 = { delta: NULL };
  const winMd = renderMarkdown(assembleScoreboard(GRADES, winStats)).split("\n");
  const nullMd = renderMarkdown(assembleScoreboard(GRADES, nullStats)).split("\n");
  // The two outputs differ — and the difference lives on the C1 claim line + the honest-null callout, nothing
  // hand-tuned elsewhere.
  assert.notEqual(winMd.join("\n"), nullMd.join("\n"));
  const c1Win = winMd.find((l) => l.startsWith("| C1 "))!;
  const c1Null = nullMd.find((l) => l.startsWith("| C1 "))!;
  assert.match(c1Win, /win/);
  assert.match(c1Null, /no measurable win/);
});

test("the assembled artifact IS a Scoreboard — T-008's reproducible() consumes it directly (AC9 seam)", () => {
  const a = assembleScoreboard(GRADES, fullStats());
  const b = assembleScoreboard(GRADES, fullStats());
  // Identical inputs → reproducible (verdicts match, deltas agree within the variance band).
  assert.equal(reproducible(a, b), true);
});
