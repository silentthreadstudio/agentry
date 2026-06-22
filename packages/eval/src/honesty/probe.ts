// The HONESTY probe (ADR-001 §honesty) — a THIN COMPOSER over Agentry's two honesty signals, neither of which
// re-conducts a task:
//   1. OVERCLAIM-GAP — the PURE rate over the unified conduct records (T-03): said DONE but judged below the quality
//      bar. Computed by `buildOverclaim` over the SAME records the rightsizing scorer consumes (no extra run).
//   2. FLOW-COMPLIANCE — did an escalated conduct follow its own process (run_start-before-dispatch,
//      spec-before-tasks, single-frontmatter, no-skip-flag)? Reuses the moved `flow-compliance/` probe VERBATIM —
//      this probe CONSUMES it (one verdict per escalated run dir), it does not rewrite the assertions.
//
// Like every public probe (ADR-002 §the uniform contract) the emitted artifact has TWO terminal conditions:
//   - `"aborted"` — a control gate fired UPSTREAM (the conduct's controls-first ladder, T-03); the firing verdict is
//     carried and NO numbers are produced (`overclaim`/`compliance` ABSENT) — the observable proof scoring did not run.
//   - `"scored"` — the records are gated; the overclaim artifact + the per-run flow-compliance census are populated.
// There is NO bare-vs-Agentry delta anywhere (ADR-003 de-bare): the bench is Agentry-value-only.
//
// This probe drives NO live runner: overclaim is pure over records, and flow-compliance is a read-only assertion
// over already-produced run dirs. It owns only the compose → assemble → write flow.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EvalObserver } from "../store/schema.ts";

import { runFlowComplianceProbe, type FlowComplianceArtifact } from "./flow-compliance/probe.ts";
import {
  buildOverclaim,
  type OverclaimArtifact,
  type OverclaimRecord,
  type OverclaimOptions,
} from "./overclaim.ts";

/** One escalated run dir to assert flow-compliance over, tagged with the run it came from (provenance for the census). */
export interface ComplianceTarget {
  /** The run identity (the fixture/run id) — carried onto the compliance census row. */
  runId: string;
  /** The escalated run dir (`.agentry/work/<slug>/`) the flow-compliance probe reads. */
  runDir: string;
}

/** One run's flow-compliance verdict in the honesty census — the run id paired with its pass + the full breakdown. */
export interface ComplianceCensusRow {
  /** The run identity (provenance). */
  runId: string;
  /** PASS iff every ordered check passed. */
  pass: boolean;
  /** The full flow-compliance artifact (the ordered checks + caveat) — the readable trace. */
  verdict: FlowComplianceArtifact;
}

/** The flow-compliance half of the honesty artifact: the per-run verdicts + the pass rate over the escalated runs. */
export interface ComplianceSummary {
  /** Escalated runs asserted (the denominator); 0 when no escalated run was conducted. */
  total: number;
  /** Runs whose flow-compliance verdict PASSED (the numerator). */
  passCount: number;
  /** Fraction of escalated runs that were flow-compliant, over `total`; 0 when none. */
  compliancePassRate: number;
  /** The per-run census (one verdict per escalated run dir) — the readable trace. */
  census: readonly ComplianceCensusRow[];
}

/**
 * The emitted honesty artifact (the uniform two-condition shape, ADR-002). `condition`:
 *   - `"aborted"` — a control gate fired upstream (the conduct's controls); `abortVerdict` carries the pinned
 *     verdict and NO numbers are produced (`overclaim`/`compliance` ABSENT) — the observable proof scoring did not run.
 *   - `"scored"` — the records are gated; `overclaim` (the pure gap) and `compliance` (the per-run census + rate)
 *     are populated. No bare-vs-Agentry delta anywhere (ADR-003).
 */
export interface HonestyArtifact {
  condition: "scored" | "aborted";
  /** The pinned verdict of the upstream gate that aborted the run (only on `condition === "aborted"`). */
  abortVerdict?: string;
  /** The overclaim-gap (the pure rate over the unified records); ABSENT on an aborted run. */
  overclaim?: OverclaimArtifact;
  /** The flow-compliance summary (per-run verdicts + pass rate over escalated runs); ABSENT on an aborted run. */
  compliance?: ComplianceSummary;
}

/** Options for the honesty probe — the unified records (for overclaim), the escalated run dirs (for compliance), the knobs. */
export interface HonestyProbeOptions {
  /**
   * The unified per-run records the overclaim-gap is computed over — the SAME records T-03's conduct emits (no
   * re-conduct). Each carries `selfReportedDone` + the judged `result`; an absent signal is never an overclaim.
   */
  records: readonly OverclaimRecord[];
  /**
   * The escalated run dirs to assert flow-compliance over (one per escalated conduct). EMPTY/omitted ⇒ no compliance
   * pairing (a run with only one-shots leaves no escalated run dir — correct, only escalation follows the process).
   */
  complianceTargets?: readonly ComplianceTarget[];
  /**
   * When set, the run is ABORTED with this pinned verdict and NO numbers are produced — the honesty probe consumes
   * the conduct's already-gated output, so an upstream control abort is threaded through verbatim (it runs no judge
   * controls of its own; the conduct's controls-first ladder already gated the records).
   */
  abortVerdict?: string;
  /** Overclaim threshold override (defaults to the pinned `OVERCLAIM_QUALITY_THRESHOLD`). */
  overclaim?: OverclaimOptions;
  /** Additive observability seam — the store injects this for `events.jsonl` + stdout progress. Default: silent. */
  observer?: EvalObserver;
  /** The run id stamped onto emitted events (matches the store's `runs/<runId>/`). */
  runId?: string;
  /** Where the verdict artifact JSON is written. */
  outPath: string;
}

/** The probe result: the emitted artifact and where it was written. */
export interface HonestyResult {
  artifact: HonestyArtifact;
  outPath: string;
}

/**
 * Drive the honesty dimension — compose the pure overclaim-gap (over the unified records) with the flow-compliance
 * census (over the escalated run dirs), writing the verdict artifact to `opts.outPath`. When `abortVerdict` is set
 * (an upstream control fired), it short-circuits to the ABORTED artifact with NO numbers; otherwise it scores both
 * halves. No live runner, no re-conduct, no bare-vs-Agentry delta.
 */
export function runHonestyProbe(opts: HonestyProbeOptions): HonestyResult {
  const runId = opts.runId ?? "";
  const emit = (kind: "task-done" | "gate-fired", detail: string): void =>
    opts.observer?.emit?.({ kind, runId, detail, ts: new Date().toISOString() });

  if (opts.abortVerdict !== undefined) {
    emit("gate-fired", `honesty aborted upstream: ${opts.abortVerdict}`);
    const artifact: HonestyArtifact = { condition: "aborted", abortVerdict: opts.abortVerdict };
    return { artifact, outPath: writeArtifact(opts.outPath, artifact) };
  }

  const overclaim = buildOverclaim(opts.records, opts.overclaim ?? {});
  emit("task-done", `overclaim-gap ${overclaim.overclaimGap.toFixed(2)} (${overclaim.overclaimCount}/${overclaim.total})`);

  const compliance = summarizeCompliance(opts.complianceTargets ?? [], emit);

  const artifact: HonestyArtifact = { condition: "scored", overclaim, compliance };
  return { artifact, outPath: writeArtifact(opts.outPath, artifact) };
}

/**
 * Assert flow-compliance over every escalated run dir (REUSING the moved probe verbatim) and summarize into the
 * per-run census + the pass rate. Each verdict is written to a throwaway temp path (the probe is read-only over the
 * run dir, so this spends ZERO extra API). An empty target set yields a zero-denominator summary (no escalated run
 * to assert — correct, a one-shot-only conduct leaves none).
 */
function summarizeCompliance(
  targets: readonly ComplianceTarget[],
  emit: (kind: "task-done" | "gate-fired", detail: string) => void,
): ComplianceSummary {
  const census: ComplianceCensusRow[] = targets.map((target) => {
    const outPath = join(mkdtempSync(join(tmpdir(), "honesty-compliance-")), "flow-compliance.json");
    const { artifact } = runFlowComplianceProbe({ runDir: target.runDir, outPath });
    emit(artifact.pass ? "task-done" : "gate-fired", `flow-compliance ${target.runId}: ${artifact.pass ? "PASS" : "FAIL"}`);
    return { runId: target.runId, pass: artifact.pass, verdict: artifact };
  });
  const passCount = census.filter((r) => r.pass).length;
  const total = census.length;
  return {
    total,
    passCount,
    compliancePassRate: total === 0 ? 0 : passCount / total,
    census,
  };
}

/** Serialize the verdict artifact to pretty JSON at `path`. Returns the path. */
function writeArtifact(path: string, artifact: HonestyArtifact): string {
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}

// ── The exposed surface (the contract's `exposes`) ────────────────────────────────────────────────────────────────

// The pure overclaim scorer + its threshold + types.
export {
  buildOverclaim,
  OVERCLAIM_QUALITY_THRESHOLD,
  type OverclaimArtifact,
  type OverclaimRecord,
  type OverclaimCensusRow,
  type OverclaimOptions,
} from "./overclaim.ts";

// The flow-compliance probe + its assertions, re-exported from the moved module (consume, do not rewrite).
export { runFlowComplianceProbe, FLOW_COMPLIANCE_CAVEAT } from "./flow-compliance/probe.ts";
export type { FlowComplianceArtifact, FlowComplianceProbeOptions, FlowComplianceResult } from "./flow-compliance/probe.ts";
export {
  runAllChecks,
  checkRunStartBeforeDispatch,
  checkSpecBeforeTasks,
  checkSingleFrontmatter,
  checkNoSkipFlag,
  countFrontmatterBlocks,
  runExists,
  isAboveFloor,
  CHECK_IDS,
  type Check,
  type CheckId,
  type FlowVerdict,
} from "./flow-compliance/assertions.ts";
export { readRunTrace, FLOW_TYPES } from "./flow-compliance/trace.ts";
export type { RunTrace, TraceEvent, TaskFile, FlowType } from "./flow-compliance/trace.ts";
