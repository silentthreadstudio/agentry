// The reporter's view-model — the JSON contract injected into the dashboard as `window.__SELFEVAL__` (doc 08 §6).
// This is the SINGLE seam between the headless TS (which reads the run store) and the static view template (which
// renders it). The template's client JS reads exactly this shape; `load.ts` produces exactly this shape from the
// stored run. Keep the two in lockstep: a field added here must be populated by `load.ts` AND consumed by
// `assets/template.html`, or it's dead weight.
//
// SRP: types only — no I/O, no rendering. The reporter owns this contract locally (a derived projection of a run,
// dev-only per doc 09); it is NOT added to `@agentry/core` (which is the SHIPPED plugin contract).
//
// Field names are deliberately terse (`t`, `rt`, `qa`, `h`) because this object is serialized verbatim into the
// page and the template's render functions read these keys directly — they ARE the wire format, not an internal
// model that gets mapped. Honesty by construction: `routing` carries both the per-repeat distribution (`perRun`,
// `mean`, `std`) AND the confusion matrix, so the template cannot show a modal headline without the spread.

/** Run-identity header shown in the chrome (sidebar run-id, topbar chips, hero eyebrow). */
export interface PageMeta {
  /** The run id (also the source `runs/<runId>/` dir name). */
  runId: string;
  /** The fixture basename (e.g. "routing-quick"). */
  fixture: string;
  /** The multi-run repeat count (k). */
  repeats: number;
  /** ISO timestamp the page was generated — provenance for the artifact. */
  generatedAt: string;
}

/** Routing-accuracy projection. `confusion` is keyed `"<floor>|<dispatched>"` so the template indexes cells directly. */
export interface RoutingData {
  /** Per-repeat accuracy values — the raw distribution behind `mean` (drawn as individual bars). */
  perRun: number[];
  /** Mean accuracy across repeats. */
  mean: number;
  /** Standard deviation across repeats — the spread the headline must not hide. */
  std: number;
  /** The shape vocabulary in canonical order (one-shot, spec-first, decompose) — matrix rows/cols. */
  floors: string[];
  /** Confusion counts keyed `"<labeledFloor>|<dispatched>"`; absent keys are zero. */
  confusion: Record<string, number>;
  /** Task ids whose dispatched shape was not unanimous across repeats. */
  noisy: string[];
  /** Task ids dispatched above their floor (heavier than needed). */
  overRoutes: string[];
  /** Task ids dispatched below their floor (lighter — the trap-sensitive direction). */
  underRoutes: string[];
}

/** Decision-quality projection — the aggregate, per-dimension means, and the trust controls. */
export interface QualityData {
  /** Mean recomputed overall across all judged artifacts, in [0,1]. */
  overall: number;
  /** Per-dimension means keyed by DISPLAY name (e.g. "Fork surfacing"), each 0–2. */
  dims: Record<string, number>;
  /** The discrimination + stability controls. */
  controls: { gold: number; poor: number; aa: number };
}

/** One labeled task's per-repeat behavior + (optional) judged quality and fork rationale. */
export interface TaskData {
  /** The labeled task id. */
  id: string;
  /** The labeled correct floor. */
  floor: string;
  /** Dispatched shape per repeat, in run order. */
  shapes: string[];
  /** Wall-clock seconds per repeat, in run order (paired with `shapes`). */
  t: number[];
  /** Short prose on the load-bearing fork — empty when not captured (one-shot tasks, or store lacks it). */
  fork: string;
  /** Per-repeat decision-quality overall in [0,1], or null for a one-shot task with no artifact to judge. */
  quality: number[] | null;
  /** True when the task's dispatched shape wobbled across repeats. */
  noisy: boolean;
}

/** One corrections-log entry — a time the meter disagreed with the conductor and the conductor was right (curated). */
export interface Correction {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** High-severity (a wrong number that would have shipped) vs. a refinement. */
  high: boolean;
  /** Headline (what was wrong). */
  h: string;
  /** What the meter said. */
  meter: string;
  /** What was actually true. */
  truth: string;
  /** How the meter (not the conductor) was fixed. */
  fix: string;
}

/** One row of the run-history table — a prior captured run summarized. */
export interface HistoryRow {
  /** The run id. */
  id: string;
  /** Fixture basename. */
  fixture: string;
  /** Task count. */
  n: number;
  /** Repeat count (k). */
  k: number;
  /** Human "when" label (e.g. "Jun 17 · 11:58"). */
  when: string;
  /** Human duration label (e.g. "29m"). */
  dur: string;
  /** Routing mean accuracy. */
  rt: number;
  /** Quality overall mean, or null when the run had no quality pass. */
  qa: number | null;
  /** True for the run this page is about (highlighted "active"). */
  cur: boolean;
}

/** The complete injected page payload — exactly `window.__SELFEVAL__`. */
export interface PageData {
  meta: PageMeta;
  routing: RoutingData;
  quality: QualityData;
  tasks: TaskData[];
  corrections: Correction[];
  history: HistoryRow[];
}
