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
  /**
   * The model id the run was pinned to (`config.model`, derived from the `--model` flag — ADR-003 de-Sonnet). The
   * template renders every cell/arm label from THIS, never a hardcoded "Sonnet": an Opus run labels as Opus. Falls
   * back to a neutral dash when the stored config carried no model.
   */
  model: string;
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

/**
 * The pre-registered falsifiable success condition the rightsizing probe carries (AC-THRESH). It is ALWAYS present
 * on the public path — the registered FORM ships before any run; only the calibration number (`target`) is null
 * while pending. `observed` is the run's measured headline (or null on an aborted run — no number when a gate
 * fires); `pass` is set only once the target is calibrated AND a run was scored. The rightsizing (X) condition
 * narrows into this view shape so the template renders the falsifiable framing uniformly.
 */
export interface SuccessConditionView {
  /** The human-readable falsifiable statement (e.g. "right-sizing-success ≥ X AND zero under-route-failure on traps"). */
  statement: string;
  /** The calibrated target value, or null while calibration is pending (the number is set by the first run). */
  target: number | null;
  /** True while the target is uncalibrated — so a reader never mistakes "not yet calibrated" for "no target". */
  calibrationPending: boolean;
  /** The measured headline this run produced, or null on an aborted run (a gate fired ⇒ no number). */
  observed: number | null;
  /** Whether the run cleared the condition; present ONLY when the target is calibrated AND a run was scored. */
  pass?: boolean;
}

/** One rightsizing census row — the readable trace of how each task was bucketed (route vs reference, result, outcome). */
export interface RightsizingCensusView {
  /** The labeled task id. */
  fixtureId: string;
  /** The fixture's defended floor REFERENCE (never ground truth). */
  correctFloor: string;
  /** The routed shape, or null when absent (a degenerate run ⇒ indeterminate). */
  shape: string | null;
  /** The judged result overall (0..1), or null when no result was judged (a timed-out build ⇒ indeterminate). */
  resultOverall: number | null;
  /** The terminal outcome this task was bucketed into. */
  outcome: string;
  /** The fixture's trap label, when it carried one. */
  trap?: string;
}

/**
 * The RIGHT-SIZING projection (ADR-001 §results-gated, replaces the old routing label-match + outcome delta). The
 * unified conduct is read TWICE — shape (vs the floor reference) and judged result — and bucketed into the three
 * published RATES plus the `indeterminate` terminal tally. NEVER a bare label-match accuracy. `condition`
 * discriminates: a `"scored"` run carries the rates + census; an `"aborted"` run carries only `abortVerdict` (a
 * control gate fired upstream — no fake numbers), with `rates`/`census` absent. The `successCondition` (the
 * pre-registered `X`) is ALWAYS present (the falsifiable form ships even on an abort).
 */
export interface RightsizingData {
  /** The rightsizing run this data came from (its own run kind — the latest in the store). */
  runId: string;
  /** "scored" ⇒ rates present; "aborted" ⇒ a gate fired, only `abortVerdict` is set. */
  condition: "scored" | "aborted";
  /** The firing control's verdict (only on `condition === "aborted"`). */
  abortVerdict?: string;
  /** Routed at-or-lighter than the floor AND result GOOD, over the determinate denominator (the headline; absent on abort). */
  rightSizingSuccessRate?: number;
  /** Result GOOD but routed HEAVIER than the floor (wasted process), over determinate; absent on abort. */
  overRouteTaxRate?: number;
  /** Result BAD and routed LIGHTER than the floor — the ONLY real routing miss, over determinate; absent on abort. */
  underRouteFailureRate?: number;
  /** No judgeable settled result, over the FULL total — its OWN rate, never folded into under-route-failure; absent on abort. */
  indeterminateRate?: number;
  /** Tasks with both signals present — the denominator of the three published rates; absent on abort. */
  determinate?: number;
  /** Total tasks scored, including indeterminate — the denominator of `indeterminateRate`; absent on abort. */
  total?: number;
  /** Raw counts behind every rate (the auditable denominators); absent on abort. */
  counts?: { rightSizingSuccess: number; overRouteTax: number; underRouteFailure: number; indeterminate: number };
  /** Must-escalate traps that were under-routed (one-shotted and FAILED) — the success condition requires this be 0; absent on abort. */
  underRoutedTraps?: number;
  /** The per-task census (the readable trace); absent on abort. */
  census?: RightsizingCensusView[];
  /** The pre-registered falsifiable target X — ALWAYS present (the form ships even on an aborted run). */
  successCondition: SuccessConditionView;
}

/** One flow-compliance census row — one escalated run's verdict (the readable trace). */
export interface ComplianceCensusView {
  /** The run identity (provenance). */
  runId: string;
  /** PASS iff every ordered flow check passed. */
  pass: boolean;
}

/**
 * The HONESTY projection (ADR-001 §honesty) — Agentry's two honesty signals, NO bare-vs-Agentry delta (ADR-003).
 *   1. OVERCLAIM-GAP — said DONE but judged quality below threshold (the precision metric).
 *   2. FLOW-COMPLIANCE — did escalated conducts follow their own process (run-before-dispatch, spec-before-tasks…)?
 * `condition` discriminates: a `"scored"` run carries the gap + compliance; an `"aborted"` run carries only
 * `abortVerdict` (an upstream gate fired), with the numbers absent.
 */
export interface HonestyData {
  /** The honesty run this data came from (rides the same run dir as rightsizing — the unified conduct). */
  runId: string;
  /** "scored" ⇒ numbers present; "aborted" ⇒ a gate fired, only `abortVerdict` is set. */
  condition: "scored" | "aborted";
  /** The firing control's verdict (only on `condition === "aborted"`). */
  abortVerdict?: string;
  /** Fraction of runs that said DONE but were judged below the quality bar, in [0,1]; absent on abort. */
  overclaimGap?: number;
  /** The overclaim numerator (said done AND judged below the threshold); absent on abort. */
  overclaimCount?: number;
  /** The overclaim denominator (every record); absent on abort. */
  overclaimTotal?: number;
  /** Fraction of escalated runs that were flow-compliant, in [0,1]; absent on abort. */
  compliancePassRate?: number;
  /** Escalated runs asserted (the compliance denominator); absent on abort. */
  complianceTotal?: number;
  /** Escalated runs whose flow-compliance verdict PASSED (the numerator); absent on abort. */
  compliancePassCount?: number;
  /** The per-run flow-compliance census (the readable trace); absent on abort. */
  complianceCensus?: ComplianceCensusView[];
}

// ── BENCH — the value-axis quality bench (the new public LEAD; subsumes rightsizing + honesty) ────────────────────
// The bench reads Agentry's actual work and derives FOUR absolute axes from one conduct per fixture (no baseline, no
// routing label-match). The template renders a 4-axis SCORECARD (TIER 1, persuasive) over a per-task census +
// controls drill-down (TIER 2). Every field below is populated by `load-bench.ts` AND read by `template.html`, or it
// is dead weight — the data/view lockstep the whole reporter is built on.

/** One axis's aggregate — mean±std over the n records that carried this axis's score (mirrors `BenchAxes`/`AxisStats`). */
export interface BenchAxisStat {
  /** The mean overall (0..1) over the `n` records that carried this axis's score. */
  mean: number;
  /** The population standard deviation of those overalls (the spread the headline must not hide). */
  std: number;
  /** The denominator — how many records carried this axis's score (an absent signal is excluded, never a 0). */
  n: number;
}

/** The FOUR measured axes, narrowed for the wire (mirrors `bench/score.ts BenchAxes`, all ABSOLUTE). */
export interface BenchAxesView {
  /** Axis A — the *thinking*: mean±std of the judged decision trail ("Decisions are sound"). */
  decisionQuality: BenchAxisStat;
  /** Axis B — the *output*: mean±std of the judged produced code tree ("Code is clean & coherent"). */
  codeQuality: BenchAxisStat;
  /** Axis B (correctness) — fraction whose held-out oracle PASSED ("…and correct"). */
  correctnessPassRate: number;
  /** Axis C — fraction that said done on not-good/incorrect work, → 0 ("Never claims done on bad work"). */
  overclaimRate: number;
  /** Axis D — over bug-prone records only, fraction of shipped bugs the oracle catches, → 0 ("Catches its own bugs"). */
  escapedDefectRate: number;
  /** Axis D (process) — fraction of all records where the separate verifier fired. */
  verifyFireRate: number;
}

/** One per-task census row — the readable Tier-2 trace of every record's four signals (mirrors `BenchCensusRow`). */
export interface BenchCensusView {
  /** The fixture id (the task identity). */
  fixtureId: string;
  /** The 0-based repeat index (the matrix variance unit). */
  repeat: number;
  /** Axis A judged decision overall (0..1), or null when no decision trail was judged (a one-shot). */
  decisionOverall: number | null;
  /** Axis B judged code overall (0..1), or null when no produced tree was judged. */
  codeOverall: number | null;
  /** The held-out oracle correctness verdict, or null when no oracle ran. */
  oraclePass: boolean | null;
  /** Whether the agent self-reported done (paired with the judged/oracle signals for honesty + escaped-defect). */
  selfReportedDone: boolean;
  /** Whether the separate verifier fired, or null when not observed. */
  verifyFired: boolean | null;
  /** Whether this fixture is the bug-prone (Axis-D) set. */
  bugProne: boolean;
  /** Whether a defect escaped (bugProne && done && oracle failed), or null on a non-bugProne record. */
  escapedDefect: boolean | null;
}

/** One descriptive value item in the SHOWCASE strip — "what you also get, demonstrated" (curated, not scored). */
export interface ShowcaseItem {
  /** The headline (e.g. "Auditable structure"). */
  title: string;
  /** One-to-two-line plain-English description of the value. */
  blurb: string;
  /** Which value pillar it belongs to — drives the strip's icon/accent. */
  kind: "structure" | "memory" | "specialists" | "workbench";
}

/**
 * The BENCH projection — the new PUBLIC LEAD. The bench conducts Agentry once per fixture and derives four ABSOLUTE
 * value axes from that single run (no baseline, no routing label-match). `condition` discriminates exactly like the
 * other probes: a `"scored"` run carries the `axes` + `census` (and `controlsPassed: true` — a scored artifact IS
 * the proof its controls passed, since any firing aborts before scoring); an `"aborted"` run carries only
 * `abortVerdict` and `controlsPassed: false` (the gate fired ⇒ no numbers). The `showcase` (the descriptive value
 * strip) and the small-N caveat are ALWAYS present (they ship even on an abort — the method is the credibility spine).
 */
export interface BenchData {
  /** The bench run this data came from (its own `kind: "bench"` run — the latest in the store). */
  runId: string;
  /** "scored" ⇒ axes + census present; "aborted" ⇒ a control gate fired, only `abortVerdict` is set. */
  condition: "scored" | "aborted";
  /** The firing control's verdict (only on `condition === "aborted"`). */
  abortVerdict?: string;
  /** True iff the credibility controls (A/A + gold↔broken discrimination, code + decision judge) all passed. */
  controlsPassed: boolean;
  /** The four measured axes; ABSENT on an aborted run (no number when a gate fires). */
  axes?: BenchAxesView;
  /** The per-task census (the Tier-2 readable trace); ABSENT on an aborted run. */
  census?: BenchCensusView[];
  /** How many fixtures the bench ran (the honest N behind the early-signal caveat); 0 on an abort. */
  fixtures: number;
  /** Repeats per fixture (k) — census rows = fixtures × repeats. */
  repeats: number;
  /** The descriptive value strip (structure/memory/specialists/workbench) — ALWAYS present, curated, not scored. */
  showcase: ShowcaseItem[];
}

/**
 * The complete injected page payload — exactly `window.__SELFEVAL__`. The PUBLIC story now LEADS with the BENCH (the
 * value-axis quality bench: four absolute axes + the showcase strip), which SUBSUMES the earlier rightsizing +
 * honesty probes (Axis B ≈ rightsizing result-quality, Axis C ≈ honesty/overclaim). There is NO bare-vs-Agentry
 * delta (de-bare) and NO routing label-match.
 *
 * `rightsizing`/`honesty` are now OPTIONAL and OFF the public lead — the public `buildPageData` no longer populates
 * them (the bench replaces them); the types + loaders are KEPT for a later cleanup, so a dev reader may still attach
 * them. `routing`/`quality` remain PARKED (ADR-002/ADR-003). `tasks/corrections/history` remain (Tier-2 explorer +
 * the corrections-log credibility centerpiece + the run-history index).
 */
export interface PageData {
  meta: PageMeta;
  /** PUBLIC LEAD — the latest bench run's projection (four absolute value axes + showcase), else absent. */
  bench?: BenchData;
  /** SUBSUMED (optional, off the public lead) — the prior right-sizing projection; bench replaces it. Loader kept. */
  rightsizing?: RightsizingData;
  /** SUBSUMED (optional, off the public lead) — the prior honesty projection; bench's Axis C replaces it. Loader kept. */
  honesty?: HonestyData;
  /** PARKED (optional, off the public path) — the retired routing label-match probe; a dev reader may still attach it. */
  routing?: RoutingData;
  /** PARKED (optional, off the public path) — decision-quality; kept as a type for the parked dev report only. */
  quality?: QualityData;
  tasks: TaskData[];
  corrections: Correction[];
  history: HistoryRow[];
}
