// Loads the RIGHT-SIZING section for the dashboard (ADR-001 §results-gated, ADR-003 IA re-lead — replaces the old
// `report/outcome.ts` bare-vs-Agentry reader). Like the moat, a rightsizing run is its OWN run kind, so the
// dashboard surfaces the LATEST rightsizing run found in the store (independent of the routing/quality run the page
// is about) — keeping the three public pillars on one page.
//
// Unlike the moat loader (which skips aborted runs so a gate-failed run never reads as a result), the rightsizing
// view must SHOW an aborted batch: when a control gate fired upstream, the dashboard renders the abort verdict
// INSTEAD of numbers (no fake scores). So this surfaces the latest rightsizing run whatever its condition, and
// narrows by it: a scored run yields the three rates + indeterminate tally + census; an aborted run yields only
// `condition + abortVerdict`. The pre-registered success condition (the falsifiable X) is ALWAYS surfaced.
//
// SRP: scan `runs/` for rightsizing runs + narrow the latest one's stored `RightsizingArtifact` into
// {@link RightsizingData}. A store with no rightsizing run yields `undefined` — the dashboard omits the section. No
// I/O beyond reading the run summaries. ZERO live API (the reporter never calls a model).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { RunSummary } from "../store/schema.ts";
import type { RightsizingData, RightsizingCensusView, SuccessConditionView } from "./model.ts";

/**
 * The run kind a rightsizing run is persisted under. The store's `RunKind` enum gains `"rightsizing"` (plan §store,
 * owned by the store task) and the CLI (T-10) sets it; until that enum lands, the kind is compared as a widened
 * string so this reader is correct the moment the store/CLI write it — and stays green now (the store enum is not in
 * this task's boundary). A summary whose kind doesn't match is skipped, so a not-yet-defined kind is simply absent.
 */
const RIGHTSIZING_KIND = "rightsizing";

/** The raw rightsizing artifact as the scorer persists it into a rightsizing run's `summary.json#artifact`. */
interface RawRightsizingArtifact {
  condition?: string;
  abortVerdict?: string;
  rates?: {
    determinate?: number;
    total?: number;
    rightSizingSuccessRate?: number;
    overRouteTaxRate?: number;
    underRouteFailureRate?: number;
    indeterminateRate?: number;
    counts?: { rightSizingSuccess?: number; overRouteTax?: number; underRouteFailure?: number; indeterminate?: number };
    underRoutedTraps?: number;
  };
  census?: Array<{
    fixtureId?: string;
    correctFloor?: string;
    shape?: string | null;
    resultOverall?: number | null;
    outcome?: string;
    trap?: string;
  }>;
  successCondition?: {
    target?: { statement?: string; value?: number | null; calibrationPending?: boolean };
    observed?: number | null;
    calibrationPending?: boolean;
    pass?: boolean;
  };
}

/**
 * Find the LATEST rightsizing run under `runsRoot` and narrow its stored `RightsizingArtifact` into
 * {@link RightsizingData}, or `undefined` when no rightsizing run exists. "Latest" is by the run's `startedAt`. Both
 * conditions are surfaced: an aborted run narrows to `{ condition: "aborted", abortVerdict }` (no numbers — the gate
 * fired); a scored run carries the three published rates + the indeterminate tally + the per-task census.
 */
export function loadRightsizing(runsRoot: string): RightsizingData | undefined {
  if (!existsSync(runsRoot)) return undefined;

  let best: { startedAt: string; runId: string; raw: RawRightsizingArtifact } | undefined;
  for (const name of readdirSync(runsRoot)) {
    const summaryPath = join(runsRoot, name, "summary.json");
    if (!isFile(summaryPath)) continue;

    let s: RunSummary;
    try {
      s = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
    } catch {
      continue;
    }
    if (String(s.kind) !== RIGHTSIZING_KIND) continue;
    const raw = s.artifact as RawRightsizingArtifact;
    if (raw?.condition !== "scored" && raw?.condition !== "aborted") continue;

    if (best === undefined || s.config.startedAt > best.startedAt) {
      best = { startedAt: s.config.startedAt, runId: s.runId, raw };
    }
  }
  if (best === undefined) return undefined;

  return narrowRightsizing(best.runId, best.raw);
}

/** Narrow one stored `RightsizingArtifact` into the {@link RightsizingData} wire shape — aborted carries only the verdict. */
function narrowRightsizing(runId: string, a: RawRightsizingArtifact): RightsizingData {
  const successCondition = narrowSuccessCondition(a);

  if (a.condition === "aborted") {
    return {
      runId,
      condition: "aborted",
      abortVerdict: a.abortVerdict ?? "control-gate-fired",
      successCondition,
    };
  }

  const r = a.rates ?? {};
  const counts = r.counts ?? {};
  const census: RightsizingCensusView[] = (a.census ?? []).map((c) => {
    const row: RightsizingCensusView = {
      fixtureId: c.fixtureId ?? "?",
      correctFloor: c.correctFloor ?? "?",
      shape: c.shape ?? null,
      resultOverall: c.resultOverall ?? null,
      outcome: c.outcome ?? "indeterminate",
    };
    if (c.trap !== undefined) row.trap = c.trap;
    return row;
  });

  return {
    runId,
    condition: "scored",
    rightSizingSuccessRate: r.rightSizingSuccessRate ?? 0,
    overRouteTaxRate: r.overRouteTaxRate ?? 0,
    underRouteFailureRate: r.underRouteFailureRate ?? 0,
    indeterminateRate: r.indeterminateRate ?? 0,
    determinate: r.determinate ?? 0,
    total: r.total ?? 0,
    counts: {
      rightSizingSuccess: counts.rightSizingSuccess ?? 0,
      overRouteTax: counts.overRouteTax ?? 0,
      underRouteFailure: counts.underRouteFailure ?? 0,
      indeterminate: counts.indeterminate ?? 0,
    },
    underRoutedTraps: r.underRoutedTraps ?? 0,
    census,
    successCondition,
  };
}

/** Narrow the pre-registered success condition (the falsifiable X) — ALWAYS present even on an aborted run. */
function narrowSuccessCondition(a: RawRightsizingArtifact): SuccessConditionView {
  const sc = a.successCondition ?? {};
  const target = sc.target ?? {};
  const view: SuccessConditionView = {
    statement: target.statement ?? "right-sizing-success ≥ X AND zero under-route-failure on traps",
    target: target.value ?? null,
    calibrationPending: sc.calibrationPending ?? target.calibrationPending ?? true,
    observed: sc.observed ?? null,
  };
  if (sc.pass !== undefined) view.pass = sc.pass;
  return view;
}

/** True iff `path` exists and is a regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
