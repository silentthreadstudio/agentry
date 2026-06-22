// The flow-compliance probe — the thin orchestrator for the dimension. Unlike routing/moat, it drives NO live
// runner: it is a READ-ONLY assertion over an already-produced run dir (`.agentry/work/<id>/`). It reads the
// observable trace (`trace.ts`), runs the four ordered checks (`assertions.ts`), wraps the result in a verdict
// artifact, and writes it. The pure scoring/ordering lives in `assertions.ts`; this module owns only the
// read → assert → emit → write flow + the observer wiring (the same `EvalObserver` seam the other probes use).

import { writeFileSync } from "node:fs";

import type { EvalObserver } from "../../store/schema.ts";

import { readRunTrace } from "./trace.ts";
import { runAllChecks, type Check } from "./assertions.ts";

/** The caveat pinned onto every verdict — what this probe does and does not claim. */
export const FLOW_COMPLIANCE_CAVEAT =
  "Read-only assertion over the observable Flow surface (events.jsonl trace + work-folder artifacts), NOT the " +
  "live dispatch/transcript stream — the ordered run_start/spec/frontmatter/skip-flag contract for one run dir.";

/** The artifact the probe emits and renders to disk: the overall verdict + the per-check breakdown. */
export interface FlowComplianceArtifact {
  /** The run dir the verdict is over (provenance). */
  runDir: string;
  /** PASS iff every check passed. */
  pass: boolean;
  /** The four ordered checks with their pass/fail + evidence. */
  checks: readonly Check[];
  /** The always-present caveat. */
  caveat: string;
}

/** Options for one flow-compliance run. No runner — the trace already exists on disk. */
export interface FlowComplianceProbeOptions {
  /** The run dir to assert over (`.agentry/work/<id>/`). */
  runDir: string;
  /** Where the verdict artifact JSON is written. */
  outPath: string;
  /** Additive observability seam — the store injects this for `events.jsonl` + stdout progress. Default: silent. */
  observer?: EvalObserver;
  /** The run id stamped onto emitted events (matches the store's `runs/<runId>/`). */
  runId?: string;
}

/** The result of a flow-compliance run: the emitted artifact and where it was written. */
export interface FlowComplianceResult {
  artifact: FlowComplianceArtifact;
  outPath: string;
}

/**
 * Run the flow-compliance probe over `opts.runDir`: read the trace, run the four ordered checks, build the
 * verdict artifact, emit per-check lifecycle lines through the observer, and write the artifact to `opts.outPath`.
 * Read-only over the run dir — it never writes into the trace, only into its own out path.
 */
export function runFlowComplianceProbe(opts: FlowComplianceProbeOptions): FlowComplianceResult {
  const runId = opts.runId ?? "";
  const trace = readRunTrace(opts.runDir);
  const verdict = runAllChecks(trace);

  for (const check of verdict.checks) {
    opts.observer?.emit?.({
      kind: check.pass ? "task-done" : "gate-fired",
      runId,
      detail: `${check.id}: ${check.pass ? "PASS" : "FAIL"} — ${check.detail}`,
      ts: new Date().toISOString(),
    });
  }

  const artifact: FlowComplianceArtifact = {
    runDir: opts.runDir,
    pass: verdict.pass,
    checks: verdict.checks,
    caveat: FLOW_COMPLIANCE_CAVEAT,
  };
  writeFileSync(opts.outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return { artifact, outPath: opts.outPath };
}
