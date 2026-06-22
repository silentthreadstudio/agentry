// Loads the HONESTY section for the dashboard (ADR-001 §honesty, ADR-003 de-bare — NO bare-vs-Agentry delta). The
// honesty artifact rides the SAME conduct as right-sizing (the unified conduct emits one record set; the rightsizing
// scorer and the honesty probe are two pure reads over it — plan §overclaim seam). So it is persisted as a sibling
// `honesty.json` inside the latest `kind: "rightsizing"` run dir, NOT under its own run kind (the store enum gains
// only `"rightsizing"`). This loader finds that run dir and reads the sibling artifact.
//
// --- The READ CONTRACT this defines (consumed by the CLI/T-10 that WRITES it, and by web/T-09a downstream): ---
//   runs/<rightsizing-run-id>/summary.json   #  kind: "rightsizing", artifact: RightsizingArtifact
//   runs/<rightsizing-run-id>/honesty.json   #  the HonestyArtifact (overclaim + flow-compliance), written verbatim
// The CLI wires both halves of the unified conduct into one run dir; this reader pairs the honesty artifact to the
// rightsizing run it shares a conduct with. A scored honesty artifact yields the gap + compliance; an aborted one
// (an upstream control fired) yields only `condition + abortVerdict`. No live API — a pure read of stored files.
//
// SRP: locate the latest rightsizing run dir + narrow its sibling `honesty.json` into {@link HonestyData}. Absent
// (no rightsizing run, or no `honesty.json` beside it) ⇒ `undefined` — the dashboard omits the section.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { RunSummary } from "../store/schema.ts";
import type { HonestyData, ComplianceCensusView } from "./model.ts";

/** The run kind the honesty artifact is paired to — it rides the unified rightsizing conduct's run dir. */
const RIGHTSIZING_KIND = "rightsizing";

/** The sibling filename the honesty probe's artifact is written under, inside the rightsizing run dir. */
const HONESTY_FILE = "honesty.json";

/** The raw honesty artifact as the honesty probe persists it (the uniform two-condition shape). */
interface RawHonestyArtifact {
  condition?: string;
  abortVerdict?: string;
  overclaim?: { overclaimGap?: number; overclaimCount?: number; total?: number };
  compliance?: {
    total?: number;
    passCount?: number;
    compliancePassRate?: number;
    census?: Array<{ runId?: string; pass?: boolean }>;
  };
}

/**
 * Find the LATEST rightsizing run under `runsRoot` and narrow its sibling `honesty.json` into {@link HonestyData},
 * or `undefined` when no rightsizing run (or no honesty artifact beside it) exists. "Latest" is by the run's
 * `startedAt` — the honesty section pairs to the SAME run the rightsizing section leads with (one unified conduct).
 * Both conditions are surfaced: an aborted artifact narrows to `{ condition: "aborted", abortVerdict }` (no numbers);
 * a scored one carries the overclaim-gap + the flow-compliance summary.
 */
export function loadHonesty(runsRoot: string): HonestyData | undefined {
  if (!existsSync(runsRoot)) return undefined;

  let best: { startedAt: string; runId: string; dir: string } | undefined;
  for (const name of readdirSync(runsRoot)) {
    const runDir = join(runsRoot, name);
    const summaryPath = join(runDir, "summary.json");
    if (!isFile(summaryPath)) continue;

    let s: RunSummary;
    try {
      s = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
    } catch {
      continue;
    }
    if (String(s.kind) !== RIGHTSIZING_KIND) continue; // widened: the store enum gains "rightsizing" (store task)

    if (best === undefined || s.config.startedAt > best.startedAt) {
      best = { startedAt: s.config.startedAt, runId: s.runId, dir: runDir };
    }
  }
  if (best === undefined) return undefined;

  const honestyPath = join(best.dir, HONESTY_FILE);
  if (!isFile(honestyPath)) return undefined;

  let raw: RawHonestyArtifact;
  try {
    raw = JSON.parse(readFileSync(honestyPath, "utf8")) as RawHonestyArtifact;
  } catch {
    return undefined;
  }
  if (raw.condition !== "scored" && raw.condition !== "aborted") return undefined;

  return narrowHonesty(best.runId, raw);
}

/** Narrow one stored `HonestyArtifact` into the {@link HonestyData} wire shape — aborted carries only the verdict. */
function narrowHonesty(runId: string, a: RawHonestyArtifact): HonestyData {
  if (a.condition === "aborted") {
    return { runId, condition: "aborted", abortVerdict: a.abortVerdict ?? "control-gate-fired" };
  }

  const oc = a.overclaim ?? {};
  const comp = a.compliance ?? {};
  const census: ComplianceCensusView[] = (comp.census ?? []).map((c) => ({
    runId: c.runId ?? "?",
    pass: c.pass ?? false,
  }));

  return {
    runId,
    condition: "scored",
    overclaimGap: oc.overclaimGap ?? 0,
    overclaimCount: oc.overclaimCount ?? 0,
    overclaimTotal: oc.total ?? 0,
    compliancePassRate: comp.compliancePassRate ?? 0,
    complianceTotal: comp.total ?? 0,
    compliancePassCount: comp.passCount ?? 0,
    complianceCensus: census,
  };
}

/** True iff `path` exists and is a regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
