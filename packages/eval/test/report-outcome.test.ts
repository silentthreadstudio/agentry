// Tests for the value-axis BENCH report (Phase 4 of the reshape) — the public report now LEADS with the four-axis
// value bench, which SUBSUMES the earlier rightsizing + honesty probes. Driven from a SYNTHETIC `kind:"bench"` run on
// disk with ZERO API spend. The synthetic `BenchArtifact` is built by the REAL `buildBenchArtifact` /
// `buildAbortedBenchArtifact` (so the loader is tested against the actual stored shape, not a hand-rolled guess),
// written into a fake `runs/<id>/summary.json` (kind "bench"), then read back by `loadBench` and rendered by
// `renderPage`. Asserts the load-bearing axis figures appear (decision/code mean+std+n, correctness, overclaim,
// escaped-defect), the showcase strip + the early-signal caveat ship, the controls-passed flag rides a scored run,
// and — for an aborted batch — the abort verdict instead of numbers. The render-zero-API + corrections regressions
// stay. No bare-vs-Agentry delta; no hardcoded "Sonnet".

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildBenchArtifact,
  buildAbortedBenchArtifact,
  type BenchArtifact,
  type BenchRecord,
} from "../src/bench/score.ts";
import type { Score } from "../src/judge/engine.ts";
import type { RunSummary } from "../src/store/schema.ts";
import { loadBench } from "../src/report/load-bench.ts";
import { renderPage } from "../src/report/render.ts";
import type { BenchData, PageData } from "../src/report/model.ts";

// --- fixtures ----------------------------------------------------------------------------------------------------

/** A judged `Score` whose `overall` is `n` (0..1) — the scorer reads only `overall` (dimensions are unused here). */
function score(overall: number): Score {
  return { dimensions: {}, overall, rationale: "synthetic" };
}

/**
 * A spread of bench records exercising every axis path:
 *   - rs-dedupe (×2): decision + code judged, oracle pass, done                ⇒ A & B counted, no overclaim
 *   - rs-format (×2): ONE-SHOT (no decision trail), code judged, oracle pass   ⇒ excluded from Axis A's denominator
 *   - rs-webhooks (bug-prone): done, oracle pass                               ⇒ no escaped defect
 *   - rs-jobq (bug-prone): done, oracle FAIL                                   ⇒ escaped defect (Axis D) + overclaim
 */
function benchRecords(): BenchRecord[] {
  return [
    { fixtureId: "rs-dedupe", repeat: 0, bugProne: false, selfReportedDone: true, decisionScore: score(0.92), codeScore: score(0.88), oraclePass: true, verifyFired: true },
    { fixtureId: "rs-dedupe", repeat: 1, bugProne: false, selfReportedDone: true, decisionScore: score(0.88), codeScore: score(0.84), oraclePass: true, verifyFired: true },
    { fixtureId: "rs-format", repeat: 0, bugProne: false, selfReportedDone: true, codeScore: score(0.79), oraclePass: true, verifyFired: false }, // one-shot: no decisionScore
    { fixtureId: "rs-format", repeat: 1, bugProne: false, selfReportedDone: true, codeScore: score(0.81), oraclePass: true, verifyFired: false },
    { fixtureId: "rs-webhooks", repeat: 0, bugProne: true, selfReportedDone: true, decisionScore: score(0.90), codeScore: score(0.86), oraclePass: true, verifyFired: true },
    { fixtureId: "rs-jobq", repeat: 0, bugProne: true, selfReportedDone: true, decisionScore: score(0.81), codeScore: score(0.72), oraclePass: false, verifyFired: true }, // escaped defect + overclaim
  ];
}

/**
 * Write a fake bench run to disk: `runs/<runId>/summary.json` (kind "bench") + `config.json`, carrying the artifact
 * verbatim. Returns the `runsRoot` the loader scans. `model`/`k` flow into `config` (the de-Sonnet arm label + the
 * census repeat count).
 */
function makeRun(
  artifact: BenchArtifact,
  startedAt: string,
  opts: { runId?: string; model?: string; k?: number } = {},
): string {
  const runId = opts.runId ?? "bench-test";
  const root = mkdtempSync(join(tmpdir(), "selfeval-bench-"));
  const runsRoot = join(root, "runs");
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });

  const config = {
    runId,
    kind: "bench" as RunSummary["kind"],
    startedAt,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.k ? { k: opts.k } : {}),
  };
  const summary: RunSummary = {
    runId,
    kind: "bench" as RunSummary["kind"],
    schemaVersion: "1",
    config,
    taskCount: artifact.census?.length ?? 0,
    finishedAt: startedAt,
    artifact,
  };
  writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return runsRoot;
}

/**
 * Drop the bench section into a minimal `PageData` so `renderPage` exercises the real template. Mirrors the PUBLIC
 * page the reporter actually produces: the bench LEADS, and rightsizing/honesty/routing/quality are NOT attached
 * (subsumed / parked). The page must render cleanly with only the bench + the Tasks/corrections/history sections.
 */
function pageWith(bench?: BenchData): PageData {
  return {
    meta: { runId: "r", fixture: "f", repeats: 2, model: "claude-opus-4-8[1m]", generatedAt: "2026-06-22T00:00:00.000Z" },
    ...(bench ? { bench } : {}),
    tasks: [],
    corrections: [],
    history: [],
  };
}

// --- loader: bench scored ----------------------------------------------------------------------------------------

test("loadBench: narrows a scored run into the four axes + per-task census + controlsPassed", () => {
  const artifact = buildBenchArtifact(benchRecords());
  const runsRoot = makeRun(artifact, "2026-06-22T00:00:00.000Z", { k: 2 });

  const data = loadBench(runsRoot);
  assert.ok(data, "expected a scored BenchData");
  assert.equal(data!.condition, "scored");
  // a scored artifact IS the proof its controls passed (any gate firing aborts before scoring)
  assert.equal(data!.controlsPassed, true);

  // Axis A — decision quality counted over the 4 records that carried a decisionScore (the 2 one-shots excluded)
  assert.equal(data!.axes!.decisionQuality.n, 4);
  // Axis B — code quality counted over all 6 records (every record carried a codeScore)
  assert.equal(data!.axes!.codeQuality.n, 6);
  // correctness pass-rate: 5 of 6 oracles passed (rs-jobq failed)
  assert.equal(Math.round(data!.axes!.correctnessPassRate * 100) / 100, 0.83);
  // overclaim: rs-jobq said done on a failing oracle ⇒ 1/6
  assert.ok(data!.axes!.overclaimRate > 0 && data!.axes!.overclaimRate < 0.2);
  // escaped defect: over the 2 bug-prone records, rs-jobq escaped ⇒ 1/2 = 0.5
  assert.equal(data!.axes!.escapedDefectRate, 0.5);

  // the census carries every (task × repeat) record, with the absent decision signal as null (the one-shots)
  assert.equal(data!.census!.length, 6);
  assert.ok(data!.census!.some((r) => r.fixtureId === "rs-format" && r.decisionOverall === null));
  assert.ok(data!.census!.some((r) => r.fixtureId === "rs-jobq" && r.escapedDefect === true));

  // honest N: 4 distinct fixtures, k from config
  assert.equal(data!.fixtures, 4);
  assert.equal(data!.repeats, 2);
  // the showcase strip is ALWAYS present (the value story ships with every run)
  assert.equal(data!.showcase.length, 4);
  assert.deepEqual(
    data!.showcase.map((s) => s.kind).sort(),
    ["memory", "specialists", "structure", "workbench"],
  );
});

test("loadBench: no bench run in the store ⇒ undefined (page renders without the section)", () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "selfeval-empty-"));
  assert.equal(loadBench(join(runsRoot, "runs")), undefined);
});

test("loadBench: picks the LATEST bench run by startedAt", () => {
  const older = buildBenchArtifact(benchRecords());
  const runsRoot = makeRun(older, "2026-06-21T00:00:00.000Z", { runId: "old-run" });
  // a newer aborted run lands in the same store
  const newerDir = join(runsRoot, "new-run");
  mkdirSync(newerDir, { recursive: true });
  const newerSummary: RunSummary = {
    runId: "new-run", kind: "bench" as RunSummary["kind"], schemaVersion: "1",
    config: { runId: "new-run", kind: "bench" as RunSummary["kind"], startedAt: "2026-06-23T00:00:00.000Z" },
    taskCount: 0, finishedAt: "2026-06-23T00:00:00.000Z",
    artifact: buildAbortedBenchArtifact("bench-code-judge-discrimination: gap too small"),
  };
  writeFileSync(join(newerDir, "summary.json"), `${JSON.stringify(newerSummary, null, 2)}\n`, "utf8");

  const data = loadBench(runsRoot);
  assert.equal(data!.runId, "new-run");
  assert.equal(data!.condition, "aborted");
  assert.equal(data!.controlsPassed, false);
});

// --- loader: bench aborted ---------------------------------------------------------------------------------------

test("loadBench: narrows an aborted run into the verdict, with NO axes and controlsPassed=false", () => {
  const artifact = buildAbortedBenchArtifact("bench-decision-judge-aa: judge unstable");
  const runsRoot = makeRun(artifact, "2026-06-22T00:00:00.000Z");

  const data = loadBench(runsRoot);
  assert.equal(data!.condition, "aborted");
  assert.equal(data!.abortVerdict, "bench-decision-judge-aa: judge unstable");
  assert.equal(data!.controlsPassed, false);
  assert.equal(data!.axes, undefined);
  assert.equal(data!.census, undefined);
  // even an aborted run still ships the showcase strip (the value story survives an abort)
  assert.equal(data!.showcase.length, 4);
});

// --- render: the bench-led IA ------------------------------------------------------------------------------------

test("renderPage: a scored bench run injects the four axes as the page payload (no delta — value-only)", () => {
  const artifact = buildBenchArtifact(benchRecords());
  const runsRoot = makeRun(artifact, "2026-06-22T00:00:00.000Z", { k: 2 });
  const html = renderPage(pageWith(loadBench(runsRoot)!));

  // the public IA leads with the bench scorecard + drill-down views
  assert.match(html, /data-view="summary"/);
  assert.match(html, /data-view="census"/);
  assert.match(html, /data-view="distribution"/);
  assert.match(html, /data-view="controls"/);

  // the retired probes are GONE from the public IA — no nav buttons, no `<section>`s
  assert.doesNotMatch(html, /data-view="moat"/);
  assert.doesNotMatch(html, /data-view="rightsizing"/);
  assert.doesNotMatch(html, /data-view="honesty"/);
  assert.doesNotMatch(html, /data-view="routing"/);
  assert.doesNotMatch(html, /data-view="quality"/);

  // the synthetic bench data is the injected payload, not the baked sample
  assert.match(html, /window\.__SELFEVAL__ = .*"condition":"scored"/);
  assert.match(html, /"controlsPassed":true/);
  assert.match(html, /"decisionQuality":/);
  assert.match(html, /"escapedDefectRate":0\.5/);

  // value-only (ADR-003): no head-to-head delta wire field anywhere on the page
  assert.equal(/"delta":/.test(html), false, "no delta wire field on the value-only page");
  // de-Sonnet: no hardcoded "Sonnet" literal in the rendered output
  assert.doesNotMatch(html, /Sonnet/);
});

test("renderPage: an aborted bench run renders the abort verdict instead of axes", () => {
  const artifact = buildAbortedBenchArtifact("bench-code-judge-discrimination: gap 0.06 < 0.20");
  const runsRoot = makeRun(artifact, "2026-06-22T00:00:00.000Z");
  const html = renderPage(pageWith(loadBench(runsRoot)!));

  assert.match(html, /"condition":"aborted"/);
  assert.match(html, /"controlsPassed":false/);
  assert.match(html, /bench-code-judge-discrimination/);
  // the abort verdict rides the page payload; the template renders the aborted state from it (no fake axes)
  assert.equal(/"escapedDefectRate":/.test(html), false, "an aborted run carries no axes");
});

// --- render: zero-API standalone + corrections regressions -------------------------------------------------------

test("renderPage: a page with no bench data still renders (sections degrade to empty states)", () => {
  const html = renderPage(pageWith()); // no bench / rightsizing / honesty / routing / quality
  // the scorecard + drill-down views are present in the template chrome even with nothing attached
  assert.match(html, /data-view="summary"/);
  assert.match(html, /data-view="census"/);
  // the injected payload carries no bench field
  assert.doesNotMatch(html, /window\.__SELFEVAL__ = .*"bench":/);
  // still no routing/quality field (parked off the public path)
  assert.doesNotMatch(html, /window\.__SELFEVAL__ = .*"routing":/);
  assert.doesNotMatch(html, /window\.__SELFEVAL__ = .*"quality":/);
});

test("renderPage: the corrections log is a first-class trust section in the bench IA", () => {
  const page = pageWith(loadBench(makeRun(buildBenchArtifact(benchRecords()), "2026-06-22T00:00:00.000Z"))!);
  page.corrections = [
    { date: "2026-06-16", high: true, h: "Dispatch-pattern proxy was invalid", meter: "scored one-shot", truth: "the conductor escalated", fix: "read the artifacts, not the tool pattern" },
  ];
  const html = renderPage(page);

  // the corrections nav + the "corrections log is the product" framing survive into the bench report
  assert.match(html, /data-view="corrections"/);
  assert.match(html, /corrections log is the product/i);
  // the injected correction rides the payload
  assert.match(html, /"Dispatch-pattern proxy was invalid"/);
});
