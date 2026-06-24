// The artifact-store's typed contract (ADR-001 / ADR-002). These types describe what a self-eval RUN is and
// what it persists under `selfeval/runs/<id>/`. They are DEV-ONLY (doc 09) and deliberately NOT added to
// `@agentry/core` — `@agentry/core` stays the single source of truth for *shipped* plugin contracts; the
// eval store owns its run/task schema locally. selfeval is self-contained and is NOT wired to `@agentry/core`,
// so the lifecycle event it emits is the local `EvalEvent` below (not core's `WorkEvent`) — no cross-package
// import, no runtime dependency, module stays pure (no I/O).
//
// SRP: this module is types only. The id generator lives in `runId.ts`; the write/read/event adapters (sibling
// tasks T-B/C/E) live in their own modules and import these types.

/**
 * The on-disk schema version, stamped into `config.json` and `summary.json` (ADR-001). Bump when the run-dir
 * layout changes so a later reporter/UI can detect a mismatch instead of mis-parsing silently. A string (not an
 * int) so a future scheme like "2.1" stays representable without a type change.
 */
export const SCHEMA_VERSION = "1";

/**
 * The probe kinds a run can be. The PUBLIC set is `rightsizing` (the unified conduct-and-judge run, which the
 * honesty artifact rides as a sibling `honesty.json`). `routing` / `quality` / `moat` / `outcome` are retained kinds
 * for back-compat with already-stored runs the offline `replay`/`report` readers may still open — the live CLI no
 * longer writes them. `moat` in particular stays in the union so a historical moat run dir reads without error.
 */
export type RunKind = "routing" | "quality" | "moat" | "outcome" | "rightsizing";

/**
 * The resolved parameters of one run — the reproducibility header written verbatim to `config.json` (ADR-001).
 * Fields are derived from `RoutingProbeOptions` / `QualityProbeOptions` (the probes' own option shapes): the
 * persisted config records HOW a run was parameterized so any later analysis is auditable. The probe-specific
 * knobs (`fixtureDir`, `k`, `runs`) are optional because a quality run doesn't carry routing's `fixtureDir`/`runs`
 * and vice-versa; the write side fills only what its probe used.
 */
export interface RunConfig {
  /** The run id (also the `runs/<runId>/` directory name). */
  runId: string;
  /** Which probe this run drove. */
  kind: RunKind;
  /** Routing only — the directory holding the labeled `tasks.yaml` (`RoutingProbeOptions.fixtureDir`). */
  fixtureDir?: string;
  /** The A/A repeat count both probes accept (`*ProbeOptions.k`). */
  k?: number;
  /** Routing only — the multi-run variance count (`RoutingProbeOptions.runs`). */
  runs?: number;
  /** The model id pinned for the run (`*ProbeOptions.model`). */
  model?: string;
  /** Routing only — the plugin root Agentry was loaded from (`RoutingProbeOptions.pluginDir`). */
  pluginDir?: string;
  /** Wall-clock ISO timestamp the run began — the chronological anchor for the reproducibility header. */
  startedAt: string;
}

/**
 * One labeled task's persisted record (ADR-001, `tasks/<taskId>[.r<i>]/`). Captures what the store knows about a
 * task after it ran: which labeled floor it carried (routing), the shape that was dispatched, and how long it took.
 * `runIndex` is present only under multi-run (`runs > 1`) to disambiguate the `.r<i>` task dirs.
 */
export interface TaskRecord {
  /** The labeled task id (the `tasks/<taskId>/` dir name, minus any `.r<i>` suffix). */
  taskId: string;
  /** The 0-based repeat index when the task ran more than once (`runs > 1`); absent for a single run. */
  runIndex?: number;
  /** Routing only — the labeled correct floor the dispatched shape is scored against. */
  labeledFloor?: string;
  /** The dispatched shape the probe extracted for this task (e.g. "one-shot" | "spec-first" | "decompose"). */
  shape: string;
  /** Wall-clock duration of the task's run, in milliseconds. */
  timingMs: number;
}

/**
 * The run-level summary written to `summary.json` (ADR-001). Wraps the run header + the probe's OWN returned
 * artifact verbatim — so no probe-artifact schema is re-declared here (that would create an import cycle and
 * duplicate the probe's contract). `artifact` is typed `unknown` on purpose: this module must not import
 * `RoutingArtifact`/`QualityArtifact` from the probes; the write side stores whatever the probe returned and a
 * reader narrows it by `kind`.
 */
export interface RunSummary {
  /** The run id (matches `RunConfig.runId`). */
  runId: string;
  /** Which probe produced the summary. */
  kind: RunKind;
  /** The on-disk schema version this run was written under ({@link SCHEMA_VERSION}). */
  schemaVersion: string;
  /** The resolved run config (the same object written to `config.json`). */
  config: RunConfig;
  /** How many task records the run captured. */
  taskCount: number;
  /** Wall-clock ISO timestamp the run finished. */
  finishedAt: string;
  /** The probe's returned artifact (`RoutingArtifact` | `QualityArtifact`), stored verbatim — kept `unknown` to
   *  avoid importing the probe artifacts and creating a dependency cycle. A reader narrows it by `kind`. */
  artifact: unknown;
}

/**
 * The input the WRITE side (T-B) needs to capture one task out of its sandbox before the sandbox is discarded
 * (ADR-001's keystone ordering). It names the source paths to copy — the per-task `stream.jsonl` and the
 * `work/` tree under `sandboxDir` — plus the already-extracted shape and timing. This is the payload the probe
 * seam (T-D) hands to `EvalObserver.onTaskComplete`.
 */
export interface TaskCaptureSrc {
  /** The labeled task id. */
  taskId: string;
  /** The 0-based repeat index when `runs > 1` (drives the `.r<i>` task-dir suffix); absent for a single run. */
  runIndex?: number;
  /** The task's sandbox working dir — the source root whose `.agentry/work/` tree is copied to `tasks/<id>/work/`. */
  sandboxDir: string;
  /** Absolute path to the captured `stream.jsonl` to copy out of the sandbox. */
  streamPath: string;
  /** The dispatched shape the probe extracted for this task. */
  shape: string;
  /** Wall-clock duration of the task's run, in milliseconds. */
  timingMs: number;
}

/**
 * A self-eval lifecycle event (local; selfeval is self-contained — not `@agentry/core`'s `WorkEvent`). This is the
 * line shape appended to `events.jsonl` and surfaced as a stdout progress line (ADR-002). It is intentionally a
 * small, self-contained record so the eval store carries no cross-package dependency.
 */
export interface EvalEvent {
  /** Which point in a run's lifecycle this event marks. */
  kind: "run-started" | "task-started" | "task-done" | "gate-fired" | "run-done";
  /** The run id this event belongs to (matches `RunConfig.runId`). */
  runId: string;
  /** A human-readable progress/status line. */
  detail: string;
  /** Wall-clock ISO timestamp the event was emitted. */
  ts: string;
}

/**
 * The injected observability PORT the probes receive (ADR-002 + ADR-001 capture seam). Both hooks are OPTIONAL so
 * the default (no observer / both absent) is byte-for-byte today's silent, no-capture probe behavior — the AC5
 * guarantee by construction. The probe only ever WRITES through this sink (never reads it), so it cannot affect
 * the probe's gated decisions. This is the single seam T-D threads in and T-B/T-C implement.
 */
export interface EvalObserver {
  /** Append a lifecycle event (events.jsonl + stdout progress line). The local {@link EvalEvent} shape. */
  emit?(event: EvalEvent): void;
  /** Fired at each task's completion — hands the write side the paths to copy out before the sandbox is gone. */
  onTaskComplete?(src: TaskCaptureSrc): void;
}
