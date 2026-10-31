// The bench's COST ADMISSION LEDGER — the pure decision core behind `--budget-usd`. A bench conducts real
// `claude -p` runs, and a benchmark you are afraid to run is a benchmark that does not get run; this is the
// ceiling that makes it usable.
//
// WHY ADMISSION CONTROL AND NOT A MID-TASK ABORT: a task's cost is only knowable from the trailing `result`
// envelope of its `stream.jsonl` (`total_cost_usd`, parsed by `io/live.ts` onto `RunResult.cost`). There is NO
// mid-flight signal — nothing tells you a running task is at $0.40 of a $0.50 cap — so an abort is impossible
// from this source, and undesirable anyway: you have already paid for the partial run and would throw away the
// record. So the ledger refuses to START a task that would cross the cap. Every dollar spent yields a scored
// record, and the overshoot is bounded and stateable.
//
// CONTRACT (the invariants the probe relies on):
//   - ADMISSION TEST: a task is admitted iff `spent + inFlight x projection + projection <= cap`. The `+
//     projection` is the candidate's own reservation; `inFlight x projection` reserves every task already
//     running under `mapPool` at `concurrency > 1`, each held at the projection until its real cost replaces it.
//   - LATCHED STOP: the first refusal latches `stopped`, and every later task is refused too. Serially this is
//     forced (spend only grows, so a refusal can never become an admission). Under `concurrency > 1` it is a
//     CHOICE, and the deliberate one: reserves DO release as in-flight tasks settle cheaply, so an un-latched
//     ledger would refuse task 4 and then admit task 7 — and `mapPool` never retries a skipped index, so the
//     result would be a partial matrix with HOLES. Latching keeps a partial run a contiguous PREFIX of the plan,
//     which is the only thing "ran 3 of 15" can honestly mean. The cost of that choice is stated in the caveat
//     below.
//
// KNOWN CONSERVATISM (`concurrency > 1`): the first wave reserves at the SEED, before anything has been measured.
// A cap near `concurrency x seed` can therefore latch on that first wave and leave real budget unspent (4 slots
// against a $3.00 cap admit 3 tasks at the $1.00 seed, then stop — even if those 3 settle at $0.50 each). It errs
// toward under-spending, which is the correct direction for a guard, but it is a real effect and not a subtlety
// to discover from a surprising run: prefer a cap comfortably above `concurrency x 1.00`, or run serial.
//   - NEVER FREE: a task that settles with no measurable `total_cost_usd` is charged the PROJECTION, never $0.
//     Charging $0 would be the guard's own failure mode — an unbounded number of unmeasurable tasks would run
//     under any cap. Such a charge is counted in `tasksEstimated` so it is surfaced, not silently absorbed.
//   - PAIRING: every `admit()` that returns true is followed by exactly one `settle()`. `settle()` is called
//     even when the task threw — an errored task still spent money.
//   - `cap = Infinity` is the NO-BUDGET case: `admit()` always returns true, so the probe keeps ONE code path
//     and the no-flag behavior is byte-for-byte today's (nothing is ever refused, nothing is ever latched).

import type { BenchBudget } from "./score.ts";

/**
 * The seed projection ($) used until the FIRST task of this run settles with a measured cost — the point at
 * which nothing has been observed yet and the ledger must still be conservative. $1.00 is rounded UP from the
 * worst task cost measured over the stored bench runs to date (n=9: min $0.486, median $0.573, max $0.988), so
 * it over-reserves rather than under-reserves on the very first admission. It is a seed, not a model of task
 * difficulty: the moment a real cost lands, the observed maximum takes over.
 */
export const SEED_PROJECTION_USD = 1.0;

/** The ledger's observable state — read by the probe to stamp the run's budget block and its terminal summary. */
export interface BudgetState {
  /** The cap admissions were tested against (`Infinity` when no `--budget-usd` was given). */
  capUsd: number;
  /** Charged spend so far: measured costs, plus the projection charged for each unmeasurable task. */
  spentUsd: number;
  /** How many tasks were admitted (started). */
  tasksRun: number;
  /** How many admitted tasks settled with NO measurable cost and were charged the projection instead. */
  tasksEstimated: number;
  /** The projection currently in force — the per-slot reservation, and the unit of the overshoot bound. */
  projectionUsd: number;
  /** True once an admission has been refused — the run stopped on the budget rather than finishing the matrix. */
  stopped: boolean;
}

/** The admission ledger for one bench run. Single-threaded by construction, so check-and-admit is atomic. */
export interface BudgetLedger {
  /** Test the candidate task against the cap; true ⇒ admitted (and reserved), false ⇒ refused (and latched). */
  admit(): boolean;
  /** Settle an admitted task: release its reservation and charge its measured cost, or the projection if none. */
  settle(measuredCostUsd: number | undefined): void;
  /** Snapshot the current state (a copy — the caller cannot mutate the ledger through it). */
  state(): BudgetState;
}

/** A finite, strictly-positive cost is measurable; anything else (absent, 0, NaN, negative) is not. */
function isMeasurable(costUsd: number | undefined): costUsd is number {
  return typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0;
}

/**
 * Build the admission ledger for one bench run.
 *
 * @param capUsd The `--budget-usd` ceiling. Pass `Infinity` for "no budget" — every task is then admitted, which
 *               is exactly today's ungated behavior, without the probe needing a second code path.
 * @param seedUsd The projection to use before the first measured cost lands; defaults to
 *               {@link SEED_PROJECTION_USD}. Injectable so tests pin it instead of inheriting the historical seed.
 */
export function createBudgetLedger(
  capUsd: number,
  seedUsd: number = SEED_PROJECTION_USD,
): BudgetLedger {
  let spentUsd = 0;
  let inFlight = 0;
  let tasksRun = 0;
  let tasksEstimated = 0;
  let stopped = false;
  /** The max cost MEASURED this run; undefined until a task settles with one. An ESTIMATE never updates it —
   *  a charge we invented is not an observation, and letting it feed back would inflate the projection. */
  let observedMaxUsd: number | undefined;

  /** The conservative running estimate of what the next task will cost: the max observed this run, else the seed. */
  const projection = (): number => observedMaxUsd ?? seedUsd;

  return {
    admit(): boolean {
      if (stopped) return false;
      const p = projection();
      // The candidate reserves one projection for itself, on top of one for every task already in flight.
      if (spentUsd + inFlight * p + p > capUsd) {
        stopped = true;
        return false;
      }
      inFlight++;
      tasksRun++;
      return true;
    },

    settle(measuredCostUsd: number | undefined): void {
      inFlight--;
      if (isMeasurable(measuredCostUsd)) {
        spentUsd += measuredCostUsd;
        if (observedMaxUsd === undefined || measuredCostUsd > observedMaxUsd)
          observedMaxUsd = measuredCostUsd;
        return;
      }
      // Unmeasurable ⇒ charge the projection (never $0) and count it, so an estimated charge is visible.
      spentUsd += projection();
      tasksEstimated++;
    },

    state(): BudgetState {
      return { capUsd, spentUsd, tasksRun, tasksEstimated, projectionUsd: projection(), stopped };
    },
  };
}

/**
 * The overshoot ($) the cap can be exceeded by — stated rather than implied, and derived, not asserted.
 *
 * Admission holds the invariant `spent + inFlight x P + P <= cap` (P = the projection at that moment). Let F be
 * the set of tasks still in flight when the last admission happened, |F| <= concurrency. From the invariant at
 * that admission, `spent_then <= cap - |F| x P`, so
 *
 *     final = spent_then + SUM(actual_i, i in F)
 *           <= cap + SUM(actual_i - P, i in F)
 *           <= cap + |F| x (worstTaskCost - P)
 *
 * Two readings, both true and both worth saying out loud:
 *   - If no in-flight task costs MORE than the projection reserved for it, the cap is not exceeded at all.
 *   - A task CAN cost more than anything measured this run, and then the excess lands on top, once per slot.
 *
 * This function returns the reserved-slot figure `concurrency x projection` — the amount the ledger actually held
 * back, and the honest headline for "one in-flight task per concurrency slot". It is the bound in the ordinary
 * case (a task at or under the projection) and the scale of the surprise in the extraordinary one. It is NOT a
 * hard guarantee, and the notice below says so: a guard that implied a guarantee it cannot deliver would be worse
 * than one that states its bound.
 */
export function overshootBoundUsd(budget: BenchBudget): number {
  return budget.concurrency * budget.projectionUsd;
}

/**
 * The unmissable terminal notice for a budget-capped run — ONE source for this wording, so the event trail, the
 * summary line, and the usage text cannot drift apart. A `budget-exhausted` run leads with PARTIAL BENCH and the
 * planned/run counts (AC4); a completed run still states the bound, because the cap was in force either way (AC5).
 */
export function formatBudgetNotice(budget: BenchBudget): string {
  const usd = (n: number): string => `$${n.toFixed(2)}`;
  const head =
    budget.stopReason === "budget-exhausted"
      ? `!! PARTIAL BENCH — stopped on the --budget-usd cap: ran ${budget.tasksRun} of ${budget.tasksPlanned} planned task(s).`
      : `budget: the full matrix ran — ${budget.tasksRun} of ${budget.tasksPlanned} planned task(s).`;
  const spend = `   spent ${usd(budget.spentUsd)} of the ${usd(budget.capUsd)} cap${
    budget.tasksEstimated > 0
      ? ` (${budget.tasksEstimated} task(s) settled UNMEASURABLE and were charged the ${usd(budget.projectionUsd)} projection, not $0)`
      : ""
  }.`;
  const bound = `   the cap is an ADMISSION threshold, NOT a spend guarantee: it refuses to START a task and cannot abort one\n   already running, so spend can exceed it by up to one in-flight task per concurrency slot —\n   ${budget.concurrency} slot(s) x ${usd(budget.projectionUsd)} projection = ${usd(overshootBoundUsd(budget))}, plus whatever any single task costs above that projection.`;
  return `${head}\n${spend}\n${bound}`;
}
