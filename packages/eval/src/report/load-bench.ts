// Loads the BENCH section for the dashboard — the new PUBLIC LEAD (the value-axis quality bench, Phase 4 of the
// reshape). A bench run is its OWN run kind (`kind: "bench"`), so the dashboard surfaces the LATEST bench run found
// in the store (independent of the routing/quality run the page header is about) — keeping the value scorecard on the
// same page as the Tasks explorer + corrections log.
//
// Mirrors `loadRightsizing` exactly: scan `runs/` for the latest `kind:"bench"` run by `startedAt`, read its
// `summary.json#artifact` (the `BenchArtifact` the scorer persisted), and narrow it into the {@link BenchData} wire
// shape the template reads. Like rightsizing, BOTH conditions are surfaced — a SCORED run yields the four axes + the
// per-task census (and `controlsPassed: true`, since a scored artifact IS the proof its controls passed: any gate
// firing aborts BEFORE scoring); an ABORTED run yields only `abortVerdict` + `controlsPassed: false` (no fake
// numbers). The `showcase` strip + the `fixtures`/`repeats` N are ALWAYS populated (the method is the credibility
// spine — it ships even on an abort).
//
// SRP: scan + narrow + attach the curated showcase. A store with no bench run yields `undefined` — the dashboard
// omits the section. ZERO live API (the reporter never calls a model); no I/O beyond reading the run summaries.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { RunSummary } from "../store/schema.ts";
import type { BenchData, BenchAxesView, BenchCensusView, ShowcaseItem } from "./model.ts";

/** The run kind a bench run is persisted under (the store's `RunKind` enum carries `"bench"`). */
const BENCH_KIND = "bench";

/** The raw bench artifact as the scorer persists it into a bench run's `summary.json#artifact` (mirrors `BenchArtifact`). */
interface RawBenchArtifact {
  condition?: string;
  abortVerdict?: string;
  axes?: {
    decisionQuality?: { mean?: number; std?: number; n?: number };
    codeQuality?: { mean?: number; std?: number; n?: number };
    correctnessPassRate?: number;
    overclaimRate?: number;
    escapedDefectRate?: number;
    verifyFireRate?: number;
  };
  census?: Array<{
    fixtureId?: string;
    repeat?: number;
    decisionOverall?: number | null;
    codeOverall?: number | null;
    oraclePass?: boolean | null;
    selfReportedDone?: boolean;
    verifyFired?: boolean | null;
    bugProne?: boolean;
    escapedDefect?: boolean | null;
  }>;
}

/**
 * The curated SHOWCASE strip — the descriptive value items ("what you also get, demonstrated"). These are NOT
 * scored; they are the qualitative half of the value story (auditable process, durable memory, real specialists, a
 * human-in-the-loop control surface). Kept here (not in the artifact) because they are a property of the PRODUCT,
 * not of any one run — every bench report shows the same four, so the report never goes silent on them.
 */
const SHOWCASE: readonly ShowcaseItem[] = [
  {
    title: "Auditable structure",
    blurb: "Every escalated run leaves a spec, a plan, and ADRs you can read — the decision trail Axis A judges is the same one you audit.",
    kind: "structure",
  },
  {
    title: "Durable memory",
    blurb: "Decisions, gotchas, and repo-facts persist across runs with provenance, so run two is warmer than run one — recall is shown, never scored.",
    kind: "memory",
  },
  {
    title: "Real specialists",
    blurb: "Architect, implementer, verifier, librarian — bounded experts the conductor dispatches, so the work is built and checked by different agents.",
    kind: "specialists",
  },
  {
    title: "You stay in control",
    blurb: "The Workbench surfaces every run live with review gates and steerable tasks — the value bench measures the work you can already watch happen.",
    kind: "workbench",
  },
];

/**
 * Find the LATEST bench run under `runsRoot` and narrow its stored `BenchArtifact` into {@link BenchData}, or
 * `undefined` when no bench run exists. "Latest" is by the run's `startedAt`. Both conditions are surfaced: an
 * aborted run narrows to `{ condition: "aborted", abortVerdict, controlsPassed: false }` (no numbers — the gate
 * fired); a scored run carries the four axes + the per-task census + `controlsPassed: true`. The showcase strip +
 * the N are ALWAYS attached.
 */
export function loadBench(runsRoot: string): BenchData | undefined {
  if (!existsSync(runsRoot)) return undefined;

  let best:
    | { startedAt: string; runId: string; raw: RawBenchArtifact; repeats: number }
    | undefined;
  for (const name of readdirSync(runsRoot)) {
    const summaryPath = join(runsRoot, name, "summary.json");
    if (!isFile(summaryPath)) continue;

    let s: RunSummary;
    try {
      s = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
    } catch {
      continue;
    }
    if (String(s.kind) !== BENCH_KIND) continue;
    const raw = s.artifact as RawBenchArtifact;
    if (raw?.condition !== "scored" && raw?.condition !== "aborted") continue;

    if (best === undefined || s.config.startedAt > best.startedAt) {
      best = { startedAt: s.config.startedAt, runId: s.runId, raw, repeats: s.config.k ?? 1 };
    }
  }
  if (best === undefined) return undefined;

  return narrowBench(best.runId, best.raw, best.repeats);
}

/** Narrow one stored `BenchArtifact` into the {@link BenchData} wire shape — aborted carries only the verdict. */
function narrowBench(runId: string, a: RawBenchArtifact, repeats: number): BenchData {
  if (a.condition === "aborted") {
    return {
      runId,
      condition: "aborted",
      abortVerdict: a.abortVerdict ?? "control-gate-fired",
      controlsPassed: false,
      fixtures: 0,
      repeats,
      showcase: [...SHOWCASE],
    };
  }

  const census: BenchCensusView[] = (a.census ?? []).map((c) => ({
    fixtureId: c.fixtureId ?? "?",
    repeat: c.repeat ?? 0,
    decisionOverall: c.decisionOverall ?? null,
    codeOverall: c.codeOverall ?? null,
    oraclePass: c.oraclePass ?? null,
    selfReportedDone: c.selfReportedDone ?? false,
    verifyFired: c.verifyFired ?? null,
    bugProne: c.bugProne ?? false,
    escapedDefect: c.escapedDefect ?? null,
  }));

  // Distinct fixture ids across the census = the honest N behind the early-signal caveat (census rows are
  // fixtures × repeats, so the row count over-states N — count unique fixture ids instead).
  const fixtures = new Set(census.map((c) => c.fixtureId)).size;

  return {
    runId,
    condition: "scored",
    controlsPassed: true, // a scored artifact IS the proof: any control firing aborts BEFORE scoring.
    axes: narrowAxes(a.axes),
    census,
    fixtures,
    repeats,
    showcase: [...SHOWCASE],
  };
}

/** Narrow the four axes from the raw artifact, defaulting every missing field to a safe 0 (never NaN/undefined). */
function narrowAxes(raw: RawBenchArtifact["axes"]): BenchAxesView {
  const a = raw ?? {};
  return {
    decisionQuality: stat(a.decisionQuality),
    codeQuality: stat(a.codeQuality),
    correctnessPassRate: a.correctnessPassRate ?? 0,
    overclaimRate: a.overclaimRate ?? 0,
    escapedDefectRate: a.escapedDefectRate ?? 0,
    verifyFireRate: a.verifyFireRate ?? 0,
  };
}

/** Narrow one axis stat, defaulting a missing mean/std/n to 0. */
function stat(s: { mean?: number; std?: number; n?: number } | undefined): { mean: number; std: number; n: number } {
  return { mean: s?.mean ?? 0, std: s?.std ?? 0, n: s?.n ?? 0 };
}

/** True iff `path` exists and is a regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
