// Unit tests for the bench's COST ADMISSION LEDGER (`bench/budget.ts`) — the pure decision core behind
// `--budget-usd`. Zero I/O, zero API: the ledger is a piece of arithmetic with invariants, so it is tested
// directly rather than only through a run. The end-to-end CLI proof (a fake runner emitting chosen
// `total_cost_usd` values through `main`) lives in `cli-bench-budget.test.ts`.
//
// The admission tests pin the seed projection explicitly rather than inheriting SEED_PROJECTION_USD, so a future
// re-calibration of the historical seed cannot silently change what they assert; the seed itself is pinned once,
// in its own test, where a change to it is meant to be noticed.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SEED_PROJECTION_USD,
  createBudgetLedger,
  formatBudgetNotice,
  overshootBoundUsd,
} from "../src/bench/budget.ts";
import type { BenchBudget } from "../src/bench/score.ts";

/** Drive a serial run: admit-then-settle each cost in turn, stopping at the first refusal. Returns what ran. */
function runSerial(
  cap: number,
  seed: number,
  costs: readonly (number | undefined)[],
): { ran: number; state: ReturnType<ReturnType<typeof createBudgetLedger>["state"]> } {
  const ledger = createBudgetLedger(cap, seed);
  let ran = 0;
  for (const cost of costs) {
    if (!ledger.admit()) break;
    ran++;
    ledger.settle(cost);
  }
  return { ran, state: ledger.state() };
}

// --- admission: the cap stops NEW tasks -------------------------------------------------------------------------

test("admits while spent + projection fits the cap, and refuses the task that would cross it", () => {
  // seed 1.00 gates the first admission; from then on the projection is the max MEASURED cost (0.50).
  //   t1: 0.00 + 1.00 = 1.00 <= 1.50 ✓   t2: 0.50 + 0.50 = 1.00 ✓   t3: 1.00 + 0.50 = 1.50 ✓   t4: 2.00 ✗
  const { ran, state } = runSerial(1.5, 1.0, Array(8).fill(0.5));

  assert.equal(ran, 3, "three tasks fit under the 1.50 cap at 0.50 each");
  assert.equal(state.spentUsd, 1.5);
  assert.equal(state.stopped, true);
});

test("an exactly-fitting projection is ADMITTED (the test is `> cap`, not `>= cap`)", () => {
  const ledger = createBudgetLedger(1.0, 1.0);
  assert.equal(ledger.admit(), true, "spent 0 + projection 1.00 == the 1.00 cap ⇒ admit");
  ledger.settle(1.0);
  assert.equal(ledger.admit(), false, "spent 1.00 + projection 1.00 > the cap ⇒ refuse");
});

test("a cap smaller than the seed projection admits NOTHING — the guard bites before the first dollar", () => {
  const { ran, state } = runSerial(0.4, 1.0, [0.5, 0.5]);

  assert.equal(ran, 0);
  assert.equal(state.spentUsd, 0);
  assert.equal(state.stopped, true);
});

test("the stop LATCHES — a task refused once is never reconsidered, even though nothing more was spent", () => {
  const ledger = createBudgetLedger(0.4, 1.0);
  assert.equal(ledger.admit(), false);
  assert.equal(
    ledger.admit(),
    false,
    "spend cannot fall, so a refusal can never become an admission",
  );
  assert.equal(ledger.state().stopped, true);
});

// --- the projection: seeded, then the max MEASURED cost this run ------------------------------------------------

test("the projection tracks the max cost measured this run — an expensive task tightens later admissions", () => {
  const ledger = createBudgetLedger(10, 1.0);
  ledger.admit();
  ledger.settle(0.5);
  assert.equal(
    ledger.state().projectionUsd,
    0.5,
    "one 0.50 task ⇒ the projection follows it down from the seed",
  );

  ledger.admit();
  ledger.settle(2.0);
  assert.equal(
    ledger.state().projectionUsd,
    2.0,
    "a 2.00 task raises the projection for everything after it",
  );
});

test("the seed governs only until the first MEASURED cost lands", () => {
  const ledger = createBudgetLedger(10); // no explicit seed ⇒ the documented historical seed
  assert.equal(
    ledger.state().projectionUsd,
    SEED_PROJECTION_USD,
    "seeded before anything has settled",
  );
  ledger.admit();
  ledger.settle(0.25);
  assert.equal(ledger.state().projectionUsd, 0.25, "the first measurement replaces the seed");
});

test("the seed projection is the documented historical worst case (rounded up from max $0.988)", () => {
  assert.equal(SEED_PROJECTION_USD, 1.0);
});

// --- an unmeasurable task is charged the projection, NEVER $0 ----------------------------------------------

test("a task that settles with no measurable cost is charged the projection, not $0", () => {
  const ledger = createBudgetLedger(10, 1.0);
  ledger.admit();
  ledger.settle(undefined);

  assert.equal(ledger.state().spentUsd, 1.0, "charged the 1.00 projection");
  assert.equal(
    ledger.state().tasksEstimated,
    1,
    "and counted, so the estimate is surfaced rather than absorbed",
  );
});

test("the cap still holds when EVERY task is unmeasurable — the guard's own failure mode does not open", () => {
  // The $0 bug would run all 20; charging the projection stops after one (1.00 spent, 2.00 projected > 1.50).
  const { ran, state } = runSerial(1.5, 1.0, Array(20).fill(undefined));

  assert.equal(ran, 1);
  assert.equal(state.spentUsd, 1.0);
  assert.equal(state.tasksEstimated, 1);
  assert.equal(state.stopped, true);
});

test("an estimated charge never becomes an observation — it cannot inflate the projection", () => {
  const ledger = createBudgetLedger(10, 1.0);
  ledger.admit();
  ledger.settle(0.25); // measured ⇒ projection 0.25
  ledger.admit();
  ledger.settle(undefined); // charged 0.25, but 0.25 was never "observed"
  assert.equal(ledger.state().projectionUsd, 0.25, "still the max MEASURED cost, not the estimate");
  assert.equal(ledger.state().spentUsd, 0.5);
});

test("a zero, negative, or NaN cost counts as UNMEASURABLE, not as a free task", () => {
  for (const bogus of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const ledger = createBudgetLedger(10, 1.0);
    ledger.admit();
    ledger.settle(bogus);
    assert.equal(ledger.state().spentUsd, 1.0, `${String(bogus)} must be charged the projection`);
    assert.equal(ledger.state().tasksEstimated, 1);
  }
});

// --- concurrency: in-flight tasks are RESERVED, not ignored -----------------------------------------------------

test("in-flight tasks are reserved at the projection, so parallel admissions cannot overshoot together", () => {
  // Without a reserve, three unsettled tasks would each see spent = 0 and all be admitted under a 2.00 cap.
  const ledger = createBudgetLedger(2.0, 1.0);
  assert.equal(ledger.admit(), true, "1 in flight: 0 + 0 + 1.00 <= 2.00");
  assert.equal(ledger.admit(), true, "2 in flight: 0 + 1.00 + 1.00 <= 2.00");
  assert.equal(ledger.admit(), false, "3 in flight would reserve 3.00 > the 2.00 cap");
  assert.equal(ledger.state().tasksRun, 2);
});

test("settling releases the reservation — a cheap settle frees a slot the reserve was holding", () => {
  const ledger = createBudgetLedger(2.0, 1.0);
  ledger.admit();
  ledger.admit();
  ledger.settle(0.1); // one in flight, 0.10 spent, projection now 0.10
  assert.equal(ledger.admit(), true, "0.10 spent + 0.10 reserved + 0.10 candidate <= 2.00");
});

// --- the no-budget case: an Infinity cap is the ungated path ----------------------------------------------------

test("an Infinity cap admits everything and never latches (the no --budget-usd path)", () => {
  const { ran, state } = runSerial(Number.POSITIVE_INFINITY, 1.0, Array(50).fill(9.99));

  assert.equal(ran, 50);
  assert.equal(state.stopped, false);
});

// --- the stated overshoot bound ---------------------------------------------------------------------------------

/** A budget stamp fixture — the shape the probe writes into the artifact. */
function budgetOf(over: Partial<BenchBudget> = {}): BenchBudget {
  return {
    capUsd: 1.5,
    spentUsd: 1.5,
    tasksPlanned: 15,
    tasksRun: 3,
    tasksEstimated: 0,
    projectionUsd: 0.5,
    concurrency: 1,
    stopReason: "budget-exhausted",
    ...over,
  };
}

test("the overshoot bound is one in-flight task per concurrency slot", () => {
  assert.equal(overshootBoundUsd(budgetOf({ concurrency: 1, projectionUsd: 0.5 })), 0.5);
  assert.equal(overshootBoundUsd(budgetOf({ concurrency: 4, projectionUsd: 0.5 })), 2);
});

test("a budget-stopped run's notice says PARTIAL, the planned/run counts, and the overshoot bound", () => {
  const notice = formatBudgetNotice(budgetOf());

  assert.match(notice, /PARTIAL BENCH/, "a partial cannot be mistaken for a full bench");
  assert.match(
    notice,
    /ran 3 of 15 planned task\(s\)/,
    "the counts are in the line, not just the stored run",
  );
  assert.match(notice, /NOT a spend guarantee/, "the bound is stated, never implied");
  assert.match(
    notice,
    /1 slot\(s\) x \$0\.50 projection = \$0\.50/,
    "and quantified for this run's concurrency",
  );
});

test("a completed capped run still states the bound, and does NOT claim to be partial", () => {
  const notice = formatBudgetNotice(budgetOf({ stopReason: "completed", tasksRun: 15 }));

  assert.doesNotMatch(notice, /PARTIAL/);
  assert.match(notice, /the full matrix ran — 15 of 15/);
  assert.match(notice, /NOT a spend guarantee/);
});

test("an estimated charge is surfaced in the notice, with the reason it was not counted as $0", () => {
  const notice = formatBudgetNotice(budgetOf({ tasksEstimated: 2 }));

  assert.match(notice, /2 task\(s\) settled UNMEASURABLE/);
  assert.match(notice, /not \$0/);
});
