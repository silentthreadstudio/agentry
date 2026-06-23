// Loads the memory-hygiene (moat) section for the dashboard. Unlike routing/quality — which come from the run the
// page is about — the moat is its own run KIND, so the dashboard surfaces the LATEST scored moat run found in the
// store (independent of the current run). This keeps all three pillars on one page: routing + quality from the
// current run, the moat from the newest moat run.
//
// SRP: scan `runs/` for moat runs + narrow the latest scored one into {@link MoatData}. A store with no scored moat
// run yields `undefined` — the dashboard simply omits the moat view. No I/O beyond reading the run summaries.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { RunSummary } from "../store/schema.ts";
import type { MoatCensus, MoatData, SuccessConditionView } from "./model.ts";

/** The raw moat artifact as the probe persists it into a moat run's `summary.json#artifact` (the fields we read). */
interface RawMoatArtifact {
  condition?: string;
  runs?: number;
  compoundRate?: number;
  lighterButBadRate?: number;
  decoyLightenRate?: number;
  discrimination?: number;
  seedLandingRate?: number;
  seedLanding?: { landedCount?: number; total?: number };
  census?: MoatCensus[];
  successCondition?: {
    target?: { statement?: string; delta?: number | null; calibrationPending?: boolean };
    observed?: number | null;
    calibrationPending?: boolean;
    pass?: boolean;
  };
}

/**
 * Find the LATEST scored moat run under `runsRoot` and narrow its artifact into {@link MoatData}, or `undefined`
 * when no scored moat run exists. "Latest" is by the run's `startedAt`; an aborted moat run (a gate fired, no
 * compound number) is skipped so the dashboard never shows a gate-failed run as a result.
 */
export function loadMoat(runsRoot: string): MoatData | undefined {
  if (!existsSync(runsRoot)) return undefined;

  let best: { startedAt: string; runId: string; raw: RawMoatArtifact } | undefined;
  for (const name of readdirSync(runsRoot)) {
    const summaryPath = join(runsRoot, name, "summary.json");
    if (!isFile(summaryPath)) continue;

    let s: RunSummary;
    try {
      s = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
    } catch {
      continue;
    }
    if (s.kind !== "moat") continue;
    const raw = s.artifact as RawMoatArtifact;
    if (raw?.condition !== "scored") continue; // skip aborted (gate-fired) moat runs

    if (best === undefined || s.config.startedAt > best.startedAt) {
      best = { startedAt: s.config.startedAt, runId: s.runId, raw };
    }
  }
  if (best === undefined) return undefined;

  const a = best.raw;
  const seedLanding = { landedCount: a.seedLanding?.landedCount ?? 0, total: a.seedLanding?.total ?? 0 };
  return {
    runId: best.runId,
    runs: a.runs ?? 1,
    compoundRate: a.compoundRate ?? 0,
    lighterButBadRate: a.lighterButBadRate ?? 0,
    decoyLightenRate: a.decoyLightenRate ?? 0,
    discrimination: a.discrimination ?? 0,
    // Back-compat: a pre-k artifact has no seedLandingRate; derive it from the raw landing counts.
    seedLandingRate: a.seedLandingRate ?? (seedLanding.total === 0 ? 0 : seedLanding.landedCount / seedLanding.total),
    seedLanding,
    // Back-compat: a pre-results-gated artifact's census rows have no `lighterButBadFraction`; default it to null
    // (no basis) so the template can read it uniformly.
    census: (a.census ?? []).map((c) => ({ ...c, lighterButBadFraction: c.lighterButBadFraction ?? null })),
    successCondition: narrowSuccessCondition(a),
  };
}

/** Narrow the moat's pre-registered success condition (the falsifiable W) — ALWAYS present on the public path. */
function narrowSuccessCondition(a: RawMoatArtifact): SuccessConditionView {
  const sc = a.successCondition ?? {};
  const target = sc.target ?? {};
  const view: SuccessConditionView = {
    statement: target.statement ?? "discrimination ≥ W",
    target: target.delta ?? null,
    calibrationPending: sc.calibrationPending ?? target.calibrationPending ?? true,
    observed: sc.observed ?? (a.discrimination ?? null),
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
