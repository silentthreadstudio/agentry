// Tests for the re-led report IA (T-08, ADR-003 + ADR-002) — the public report ships EXACTLY three probes,
// MOAT → RIGHT-SIZING → HONESTY, with NO bare-vs-Agentry delta and NO hardcoded "Sonnet". Routing label-match and
// decision-quality are PARKED off the public path (ADR-002): their nav buttons and `<section>`s are GONE from the
// public IA, and the public page data carries no `routing`/`quality` field. Driven from SYNTHETIC right-sizing +
// honesty runs on disk with ZERO API spend. The synthetic `RightsizingArtifact` is built by the REAL
// `buildScoredArtifact`/`buildAbortedArtifact` (so the loader is tested against the actual stored shape, not a
// hand-rolled guess), written into a fake `runs/<id>/summary.json` (kind "rightsizing") + a sibling `honesty.json`,
// then read back by `loadRightsizing` / `loadHonesty` and rendered by `renderPage`. Asserts the load-bearing figures
// appear (the three results-gated rates + the indeterminate tally; the overclaim-gap + flow-compliance; the small-N
// framing; the model-derived arm label), the hero leads with the MOAT, the retired Routing/Decision-quality public
// sections are absent, and — for an aborted batch — the abort verdict instead of numbers. NO delta; NO "Sonnet".

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildScoredArtifact,
  buildAbortedArtifact,
  type RightsizingArtifact,
  type RightsizingRunRecord,
} from "../src/rightsizing/score.ts";
import { buildOverclaim, type OverclaimRecord } from "../src/honesty/overclaim.ts";
import type { Score } from "../src/judge/engine.ts";
import type { RunSummary } from "../src/store/schema.ts";
import { loadRightsizing } from "../src/report/rightsizing.ts";
import { loadHonesty } from "../src/report/honesty.ts";
import { renderPage } from "../src/report/render.ts";
import type { RightsizingData, HonestyData, MoatData, PageData } from "../src/report/model.ts";

// --- fixtures ----------------------------------------------------------------------------------------------------

/** A judged `Score` whose `overall` is `n` (0..1) — the scorer reads only `overall` (dimensions are unused here). */
function score(overall: number): Score {
  return { dimensions: {}, overall, rationale: "synthetic" };
}

/**
 * A spread of records exercising every terminal outcome of the results-gated scorer (ADR-001):
 *   - one-shot at a one-shot floor + good   ⇒ right-sizing-success
 *   - one-shot at a spec-first floor + good  ⇒ right-sizing-success (a lighter-than-label WIN)
 *   - decompose at a one-shot floor + good   ⇒ over-route-tax (heavier than floor)
 *   - one-shot at a spec-first floor + bad   ⇒ under-route-failure (the only real miss)
 *   - no result (timed out)                  ⇒ indeterminate (own category, off the rates' denominator)
 */
function rightsizingRecords(): RightsizingRunRecord[] {
  return [
    { fixtureId: "rs-format", correctFloor: "one-shot", shape: "one-shot", result: score(0.9), selfReportedDone: true },
    { fixtureId: "rs-dedupe", correctFloor: "spec-first", shape: "one-shot", result: score(0.85), selfReportedDone: true },
    { fixtureId: "rs-bait", correctFloor: "one-shot", shape: "decompose", result: score(0.8), selfReportedDone: true },
    { fixtureId: "rs-miss", correctFloor: "spec-first", shape: "one-shot", result: score(0.2), selfReportedDone: true },
    { fixtureId: "rs-timeout", correctFloor: "spec-first", selfReportedDone: false }, // no shape AND no result ⇒ indeterminate
  ];
}

/** Honesty overclaim records — `rs-miss` said DONE but judged below the bar ⇒ one overclaim. */
function honestyOverclaim(): OverclaimRecord[] {
  return rightsizingRecords().map((r) => ({
    fixtureId: r.fixtureId,
    ...(r.selfReportedDone !== undefined ? { selfReportedDone: r.selfReportedDone } : {}),
    ...(r.result !== undefined ? { result: r.result } : {}),
  }));
}

/** A scored honesty artifact JSON (overclaim + flow-compliance), as the honesty probe persists it to `honesty.json`. */
function honestyArtifact(): unknown {
  const overclaim = buildOverclaim(honestyOverclaim());
  return {
    condition: "scored",
    overclaim,
    compliance: {
      total: 2,
      passCount: 2,
      compliancePassRate: 1,
      census: [
        { runId: "rs-dedupe", pass: true },
        { runId: "rs-bait", pass: true },
      ],
    },
  };
}

/**
 * Write a fake right-sizing run to disk: `runs/<runId>/summary.json` (kind "rightsizing") carrying the artifact
 * verbatim, plus an optional sibling `honesty.json`. Returns the `runsRoot` the loaders scan. `model` flows into
 * `config.model` (the de-Sonnet source for the arm label).
 */
function makeRun(
  artifact: RightsizingArtifact,
  startedAt: string,
  opts: { runId?: string; model?: string; honesty?: unknown } = {},
): string {
  const runId = opts.runId ?? "rs-test";
  const root = mkdtempSync(join(tmpdir(), "selfeval-rs-"));
  const runsRoot = join(root, "runs");
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });

  const summary: RunSummary = {
    runId,
    kind: "rightsizing" as RunSummary["kind"], // the store enum gains "rightsizing" (store task); widened here
    schemaVersion: "1",
    config: { runId, kind: "rightsizing" as RunSummary["kind"], startedAt, ...(opts.model ? { model: opts.model } : {}) },
    taskCount: 5,
    finishedAt: startedAt,
    artifact,
  };
  writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (opts.honesty !== undefined) {
    writeFileSync(join(runDir, "honesty.json"), `${JSON.stringify(opts.honesty, null, 2)}\n`, "utf8");
  }
  return runsRoot;
}

/**
 * Drop the built sections into a minimal `PageData` so `renderPage` exercises the real template. Mirrors the PUBLIC
 * page the reporter actually produces: routing/quality are PARKED off the public path (ADR-002/ADR-003), so they are
 * NOT attached here — only the three public probes + the Tasks explorer ride. An optional `moat` lets a test assert
 * the moat-led hero. The page must render cleanly without any routing/quality field present.
 */
function pageWith(rightsizing?: RightsizingData, honesty?: HonestyData, moat?: MoatData): PageData {
  return {
    meta: { runId: "r", fixture: "f", repeats: 2, model: "claude-opus-4-8[1m]", generatedAt: "2026-06-19T00:00:00.000Z" },
    ...(moat ? { moat } : {}),
    ...(rightsizing ? { rightsizing } : {}),
    ...(honesty ? { honesty } : {}),
    tasks: [],
    corrections: [],
    history: [],
  };
}

/** A scored moat projection — the categorical lead (warm-vs-cold discrimination). */
function moatData(): MoatData {
  return {
    runId: "moat-test",
    compoundRate: 1,
    decoyLightenRate: 0,
    discrimination: 1,
    seedLanding: { landedCount: 1, total: 1 },
    census: [
      { taskId: "rs-dedupe", coldFloor: "spec-first", warmRelevant: "one-shot", warmDecoy: "spec-first", compounded: true, decoyHeld: true },
    ],
    successCondition: { statement: "discrimination ≥ W", target: null, calibrationPending: true, observed: 1 },
  };
}

// --- loader: right-sizing scored ---------------------------------------------------------------------------------

test("loadRightsizing: narrows a scored run into the three rates + indeterminate tally + census", () => {
  const artifact = buildScoredArtifact(rightsizingRecords());
  const runsRoot = makeRun(artifact, "2026-06-19T00:00:00.000Z");

  const data = loadRightsizing(runsRoot);
  assert.ok(data, "expected a scored RightsizingData");
  assert.equal(data!.condition, "scored");

  // 4 determinate (the 5th is indeterminate), 5 total
  assert.equal(data!.determinate, 4);
  assert.equal(data!.total, 5);
  // two right-sizing-success (incl. the lighter-than-label win), over 4 determinate
  assert.equal(data!.counts!.rightSizingSuccess, 2);
  assert.equal(data!.rightSizingSuccessRate, 0.5);
  // one over-route-tax, one under-route-failure
  assert.equal(data!.counts!.overRouteTax, 1);
  assert.equal(data!.counts!.underRouteFailure, 1);
  // indeterminate is its OWN tally over the full total (1/5), never folded into the rates
  assert.equal(data!.counts!.indeterminate, 1);
  assert.equal(data!.indeterminateRate, 0.2);
  // the census carries every task with its terminal outcome
  assert.equal(data!.census!.length, 5);
  assert.ok(data!.census!.some((r) => r.outcome === "indeterminate" && r.shape === null));
  // the pre-registered success condition is ALWAYS present (the falsifiable form ships even uncalibrated)
  assert.ok(data!.successCondition);
  assert.equal(data!.successCondition.calibrationPending, true);
});

test("loadRightsizing: no right-sizing run in the store ⇒ undefined (page renders without the section)", () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "selfeval-empty-"));
  assert.equal(loadRightsizing(join(runsRoot, "runs")), undefined);
});

test("loadRightsizing: picks the LATEST right-sizing run by startedAt", () => {
  const older = buildScoredArtifact(rightsizingRecords());
  const runsRoot = makeRun(older, "2026-06-18T00:00:00.000Z", { runId: "old-run" });
  // a newer aborted run lands in the same store
  const newerDir = join(runsRoot, "new-run");
  mkdirSync(newerDir, { recursive: true });
  const newerSummary: RunSummary = {
    runId: "new-run", kind: "rightsizing" as RunSummary["kind"], schemaVersion: "1",
    config: { runId: "new-run", kind: "rightsizing" as RunSummary["kind"], startedAt: "2026-06-20T00:00:00.000Z" },
    taskCount: 1, finishedAt: "2026-06-20T00:00:00.000Z",
    artifact: buildAbortedArtifact("controls-did-not-discriminate"),
  };
  writeFileSync(join(newerDir, "summary.json"), `${JSON.stringify(newerSummary, null, 2)}\n`, "utf8");

  const data = loadRightsizing(runsRoot);
  assert.equal(data!.runId, "new-run");
  assert.equal(data!.condition, "aborted");
});

// --- loader: right-sizing aborted --------------------------------------------------------------------------------

test("loadRightsizing: narrows an aborted run into the verdict, with NO rates", () => {
  const artifact = buildAbortedArtifact("controls-did-not-discriminate");
  const runsRoot = makeRun(artifact, "2026-06-19T00:00:00.000Z");

  const data = loadRightsizing(runsRoot);
  assert.equal(data!.condition, "aborted");
  assert.equal(data!.abortVerdict, "controls-did-not-discriminate");
  assert.equal(data!.rightSizingSuccessRate, undefined);
  assert.equal(data!.census, undefined);
  // even an aborted run still ships the falsifiable target form
  assert.ok(data!.successCondition);
});

// --- loader: honesty ---------------------------------------------------------------------------------------------

test("loadHonesty: reads the sibling honesty.json riding the latest right-sizing run", () => {
  const artifact = buildScoredArtifact(rightsizingRecords());
  const runsRoot = makeRun(artifact, "2026-06-19T00:00:00.000Z", { honesty: honestyArtifact() });

  const data = loadHonesty(runsRoot);
  assert.ok(data, "expected a scored HonestyData");
  assert.equal(data!.condition, "scored");
  // one overclaim (rs-miss said DONE, judged 0.2 < 0.5) over 5 records
  assert.equal(data!.overclaimCount, 1);
  assert.equal(data!.overclaimTotal, 5);
  assert.equal(data!.overclaimGap, 0.2);
  // flow-compliance: 2/2 escalated runs complied
  assert.equal(data!.compliancePassRate, 1);
  assert.equal(data!.complianceCensus!.length, 2);
});

test("loadHonesty: a right-sizing run with no sibling honesty.json ⇒ undefined", () => {
  const artifact = buildScoredArtifact(rightsizingRecords());
  const runsRoot = makeRun(artifact, "2026-06-19T00:00:00.000Z"); // no honesty file
  assert.equal(loadHonesty(runsRoot), undefined);
});

// --- render: the re-led IA ---------------------------------------------------------------------------------------

test("renderPage: a scored right-sizing run injects the three rates as the page payload (no delta — de-bared)", () => {
  const artifact = buildScoredArtifact(rightsizingRecords());
  const runsRoot = makeRun(artifact, "2026-06-19T00:00:00.000Z");
  const html = renderPage(pageWith(loadRightsizing(runsRoot)!));

  // the public sections lead Moat → Right-sizing → Honesty
  assert.match(html, /data-view="moat"/);
  assert.match(html, /data-view="rightsizing"/);
  assert.match(html, /data-view="honesty"/);
  // moat appears before right-sizing, which appears before honesty (the IA order in the nav)
  const navMoat = html.indexOf('data-view="moat"');
  const navRs = html.indexOf('data-view="rightsizing"');
  const navHon = html.indexOf('data-view="honesty"');
  assert.ok(navMoat < navRs && navRs < navHon, "nav order must be moat → rightsizing → honesty");

  // ADR-002 parking: the retired Routing label-match + Decision-quality probes are GONE from the PUBLIC IA — no nav
  // buttons, no `<section>`s, no per-probe badges. (The Tasks explorer + Run-history columns are a different concern.)
  assert.doesNotMatch(html, /data-view="routing"/);
  assert.doesNotMatch(html, /data-view="quality"/);
  assert.doesNotMatch(html, /id="nav-routing"/);
  assert.doesNotMatch(html, /id="nav-quality"/);

  // the synthetic right-sizing data is the injected payload, not the baked sample
  assert.match(html, /window\.__SELFEVAL__ = .*"condition":"scored"/);
  assert.match(html, /"rightSizingSuccessRate":0\.5/);
  assert.match(html, /"indeterminateRate":0\.2/);

  // de-bare (ADR-003): no head-to-head delta wire field anywhere on the page
  assert.equal(/"delta":/.test(html), false, "no delta wire field on the de-bared page");
  // small-N framing surfaced on the right-sizing section
  assert.match(html, /Early-signal · N~10 · directional/);
  // de-Sonnet: no hardcoded "Sonnet" literal in the rendered output
  assert.doesNotMatch(html, /Sonnet/);
});

test("renderPage: an aborted right-sizing run renders the abort verdict instead of rates", () => {
  const artifact = buildAbortedArtifact("controls-did-not-discriminate");
  const runsRoot = makeRun(artifact, "2026-06-19T00:00:00.000Z");
  const html = renderPage(pageWith(loadRightsizing(runsRoot)!));

  assert.match(html, /Batch aborted/);
  assert.match(html, /controls-did-not-discriminate/);
  assert.match(html, /"condition":"aborted"/);
});

test("renderPage: a honesty run injects overclaim-gap + flow-compliance (no delta)", () => {
  const artifact = buildScoredArtifact(rightsizingRecords());
  const runsRoot = makeRun(artifact, "2026-06-19T00:00:00.000Z", { honesty: honestyArtifact() });
  const html = renderPage(pageWith(loadRightsizing(runsRoot)!, loadHonesty(runsRoot)!));

  assert.match(html, /"overclaimGap":0\.2/);
  assert.match(html, /"compliancePassRate":1/);
  assert.equal(/"delta":/.test(html), false, "honesty carries no bare-vs-Agentry delta");
});

// --- hero: the public report LEADS with the moat (ADR-003) -------------------------------------------------------

test("renderPage: the Overview hero leads with the MOAT, not routing (the categorical edge headlines)", () => {
  const html = renderPage(pageWith(undefined, undefined, moatData()));

  // the default hero eyebrow is MOAT framing — never the retired routing label-match framing
  assert.match(html, /id="hero-eyebrow"[^>]*>The moat/);
  assert.doesNotMatch(html, /id="hero-eyebrow"[^>]*>Routing/);
  // the injected moat projection is the page payload (categorical warm-vs-cold), so the hero hydrates from it
  assert.match(html, /window\.__SELFEVAL__ = .*"compoundRate":1/);
  // no routing/quality view object is ever attached to the public page
  assert.equal(/"floors":\[/.test(html), false, "no routing confusion/floors wire field on the public page");
});

// --- regression: no public-section data ⇒ the page still renders --------------------------------------------------

test("renderPage: a page with no public-probe data still renders (sections degrade to empty states)", () => {
  const html = renderPage(pageWith()); // no moat / rightsizing / honesty / routing / quality
  assert.match(html, /data-view="rightsizing"/);
  assert.doesNotMatch(html, /window\.__SELFEVAL__ = .*"rightsizing"/);
  // even with NOTHING attached, the page carries no routing/quality field (parked off the public path)
  assert.doesNotMatch(html, /window\.__SELFEVAL__ = .*"routing":/);
  assert.doesNotMatch(html, /window\.__SELFEVAL__ = .*"quality":/);
});
