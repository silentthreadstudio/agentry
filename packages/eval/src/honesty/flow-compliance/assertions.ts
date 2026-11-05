// The flow-compliance assertion layer — PURE predicates over a {@link RunTrace}, mirroring the routing/moat
// control gates. Zero I/O, no API: forced-testable with synthetic traces. Each of the four ordered checks
// returns a {@link Check} (status + a human verdict); `runAllChecks` aggregates them into a {@link FlowVerdict}.
//
// The contract asserted (AS-BUILT shapes, with the single-frontmatter rule):
//   1. run_start-before-dispatch — the first `type`-bearing FLOW line precedes the first `agent-started` line. Only
//      those lines show order; the `run-state.json` roster cannot (see `firstDispatchStamp`), so roster-only
//      evidence is N/A.
//   2. spec-before-tasks — `spec.md` exists and predates the first `tasks/NNN-*.md`.
//   3. single-frontmatter — every task file parses to exactly ONE leading `---…---` block.
//   4. no-skip-flag — N/A: the hook that wrote the `flow-skipped` marker is retired, so it can never be observed.
//
// A check is `pass`, `fail`, or `na` (it could not be observed). N/A is neither a pass nor a fail, and it is never
// evidence of compliance: the OVERALL result is `pass` / `fail` / `inconclusive`, and a REQUIRED check that is N/A
// makes it `inconclusive` (a verdict must not pass a run it could not observe). `no-skip-flag` is the one check
// that is not required — its source (the retired hook) is gone for every run — so it alone never does that.
//
// "A run exists" (the above-floor floor for checks 1 and 4) = `run-state.json` present OR ≥1 FLOW (`type`) line.
// A backstop-only `events.jsonl` (only `kind` lines, e.g. `flow-skipped`) does NOT count as a run.

import type { RunTrace, TaskFile, TraceEvent } from "./trace.ts";

/** The four ordered checks, in assertion order. PINNED — the artifact/verdict consume these ids verbatim. */
export const CHECK_IDS = [
  "run-start-before-dispatch",
  "spec-before-tasks",
  "single-frontmatter",
  "no-skip-flag",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** A check's outcome. `na` = it cannot be evaluated (its source is gone): not a pass, not a fail. */
export type CheckStatus = "pass" | "fail" | "na";

/** One check's result: which check, its status, and a human-readable verdict (the evidence on FAIL). */
export interface Check {
  id: CheckId;
  status: CheckStatus;
  /** A short, evidence-bearing line — what made it pass or fail (the readable trace). */
  detail: string;
}

/** The overall result: any fail ⇒ `fail`; else any required check N/A ⇒ `inconclusive`; else `pass`. */
export type FlowResult = "pass" | "fail" | "inconclusive";

/** The aggregate verdict over a run: the {@link FlowResult}, `pass` (true only for `pass`), and the breakdown. */
export interface FlowVerdict {
  result: FlowResult;
  pass: boolean;
  checks: readonly Check[];
}

/** Checks whose N/A does not make a verdict inconclusive — their source is gone for every run, not just this one. */
const NOT_REQUIRED: ReadonlySet<CheckId> = new Set<CheckId>(["no-skip-flag"]);

/** The first FLOW (`type`-bearing) line — the run-start signal. A `kind`-only backstop line is NOT one. */
function firstFlowEvent(events: readonly TraceEvent[]): TraceEvent | undefined {
  return events.find((e) => e.type !== undefined);
}

/**
 * The `ts` of the earliest `agent-started` line (legacy; the retired subagent hook wrote these), or undefined when
 * there is none. This is the ONLY dispatch-order evidence: the roster is not, because `since` is restamped on every
 * state change (a finished agent's `since` is its return time), `agent_state` needs the handle `run_start` returns
 * (so a roster entry always postdates run_start), and `run_start` writes no event.
 */
function firstDispatchStamp(events: readonly TraceEvent[]): string | undefined {
  return events
    .filter((e) => e.kind === "agent-started")
    .map((e) => e.ts)
    .sort()[0];
}

/**
 * "A run exists" — `run-state.json` present OR ≥1 FLOW (`type`-bearing) line. A backstop-only trace (only `kind`
 * lines — including `flow-skipped`) is NOT a run. NOTE: `run_start` writes NEITHER a run-state file NOR an event,
 * so this signal alone under-counts a real escalated run that simply didn't `event_emit` — use {@link isAboveFloor}
 * for "is this an escalated run" classification; `runExists` stays the narrow event/state signal.
 */
export function runExists(trace: RunTrace): boolean {
  return trace.hasRunState || firstFlowEvent(trace.events) !== undefined;
}

/**
 * Is this an ESCALATED (above-floor) run? Detected by the **artifact surface** the run left on disk — a `spec.md`
 * plus a `plan.md` or task files — OR an explicit run signal (`run-state.json` / a FLOW event). This is the honest
 * classifier: a genuine one-shot writes NOTHING to `.agentry/work/`, so it has none of these; an escalated run that
 * skipped `event_emit` still has its artifacts, so it is correctly judged above-floor rather than escaping as
 * "sub-floor N/A". Dispatch order (check 1) is a separate question: it is N/A when no `agent-started` line exists.
 */
export function isAboveFloor(trace: RunTrace): boolean {
  return (
    trace.hasRunState ||
    firstFlowEvent(trace.events) !== undefined ||
    trace.taskFiles.length > 0 ||
    (trace.hasSpec && trace.hasPlan)
  );
}

/**
 * CHECK 1 — run_start-before-dispatch. The first FLOW (`type`) line's ts must be STRICTLY before the first
 * `agent-started` line's ts (see {@link firstDispatchStamp}). A dispatch line with no preceding FLOW line = FAIL
 * (the proven bypass made observable). With no `agent-started` line the order cannot be observed: the check is N/A,
 * never a pass or a fail — the roster alone cannot show it, and a run that dispatched before run_start looks the
 * same. Nothing writes `agent-started` lines now, so on a current run this check is N/A and the verdict inconclusive.
 */
export function checkRunStartBeforeDispatch(trace: RunTrace): Check {
  const id: CheckId = "run-start-before-dispatch";
  const earliest = firstDispatchStamp(trace.events);
  if (earliest === undefined) {
    const roster =
      trace.roster.length === 0
        ? ""
        : `; the roster (${trace.roster.length} agent(s)) cannot show order`;
    return { id, status: "na", detail: `N/A (no agent-started line${roster})` };
  }
  const flow = firstFlowEvent(trace.events);
  if (flow === undefined) {
    return {
      id,
      status: "fail",
      detail: `agent dispatched at ${earliest} with no preceding run_start/FLOW line`,
    };
  }
  const pass = flow.ts < earliest;
  return {
    id,
    status: pass ? "pass" : "fail",
    detail: pass
      ? `run_start (${flow.type} @ ${flow.ts}) precedes first dispatch @ ${earliest}`
      : `run_start (${flow.type} @ ${flow.ts}) does NOT precede first dispatch @ ${earliest}`,
  };
}

/**
 * CHECK 2 — spec-before-tasks. `spec.md` must be present AND predate the first `tasks/NNN-*.md` (by mtime). With
 * no task files there is nothing ordered after the spec ⇒ pass as long as the spec exists (or no spec + no tasks
 * is a no-op pass — an above-floor run that escalated would carry both; a sub-floor one carries neither).
 */
export function checkSpecBeforeTasks(trace: RunTrace): Check {
  const id: CheckId = "spec-before-tasks";
  const firstTask = trace.taskFiles[0];
  if (firstTask === undefined) {
    return { id, status: "pass", detail: "no task files — spec ordering not exercised" };
  }
  if (!trace.hasSpec || trace.specMtimeMs === null) {
    return {
      id,
      status: "fail",
      detail: `task file ${firstTask.name} present but spec.md is absent`,
    };
  }
  const earliestTaskMtime = Math.min(...trace.taskFiles.map((t) => t.mtimeMs));
  const pass = trace.specMtimeMs <= earliestTaskMtime;
  return {
    id,
    status: pass ? "pass" : "fail",
    detail: pass
      ? `spec.md (mtime ${trace.specMtimeMs}) predates first task (mtime ${earliestTaskMtime})`
      : `spec.md (mtime ${trace.specMtimeMs}) is NEWER than first task (mtime ${earliestTaskMtime})`,
  };
}

/**
 * Count the leading `---…---` frontmatter blocks in a task file. A single-frontmatter file opens with `---` on
 * line 1, has a closing `---`, and NO further bare `---` fence inside the body. A second stacked `---…---` block
 * (the A3/C1 regression) yields a count > 1. A file that does not open with `---` has 0 frontmatter blocks.
 */
export function countFrontmatterBlocks(text: string): number {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return 0;
  // Walk the `---` fences: each pair (open,close) is one block; a block immediately followed by another opening
  // `---` (with only blank lines between) is a second stacked frontmatter block — the failure we catch.
  let blocks = 0;
  let i = 0;
  while (i < lines.length && lines[i]?.trim() === "---") {
    // Found an opening fence at i — scan for its closing fence.
    let j = i + 1;
    while (j < lines.length && lines[j]?.trim() !== "---") j++;
    if (j >= lines.length) break; // unterminated fence — not a complete block, stop.
    blocks++;
    // Skip blank lines after the closing fence; if the next non-blank line is another `---`, it's a stacked block.
    i = j + 1;
    while (i < lines.length && lines[i]?.trim() === "") i++;
  }
  return blocks;
}

/**
 * CHECK 3 — single-frontmatter. Every `tasks/NNN-*.md` must parse to EXACTLY one leading frontmatter block; a
 * second stacked `---…---` block (the C1-stripped / A3-authored regression) = FAIL, naming the offending file(s).
 * A task file with zero frontmatter blocks is also a FAIL (a task file must carry its one frontmatter header).
 */
export function checkSingleFrontmatter(trace: RunTrace): Check {
  const id: CheckId = "single-frontmatter";
  if (trace.taskFiles.length === 0) {
    return { id, status: "pass", detail: "no task files to check" };
  }
  const offenders = trace.taskFiles
    .map((t: TaskFile) => ({ name: t.name, blocks: countFrontmatterBlocks(t.text) }))
    .filter((r) => r.blocks !== 1);
  if (offenders.length === 0) {
    return {
      id,
      status: "pass",
      detail: `all ${trace.taskFiles.length} task file(s) have exactly one frontmatter block`,
    };
  }
  const named = offenders.map((o) => `${o.name} (${o.blocks} blocks)`).join(", ");
  return {
    id,
    status: "fail",
    detail: `task file(s) without exactly one frontmatter block: ${named}`,
  };
}

/**
 * CHECK 4 — no-skip-flag. Reported N/A: the `flow-skipped` marker was written only by the `flow-run-guard` hook,
 * which is retired, so a clean trace proves nothing. It does not fail the verdict and is never a pass.
 */
export function checkNoSkipFlag(_trace: RunTrace): Check {
  return { id: "no-skip-flag", status: "na", detail: "N/A (hook retired)" };
}

/**
 * Run all four checks in order and aggregate: `fail` if any check failed; else `inconclusive` if any REQUIRED check
 * is N/A (it could not be observed, so the run is not vouched for); else `pass`.
 */
export function runAllChecks(trace: RunTrace): FlowVerdict {
  const checks: Check[] = [
    checkRunStartBeforeDispatch(trace),
    checkSpecBeforeTasks(trace),
    checkSingleFrontmatter(trace),
    checkNoSkipFlag(trace),
  ];
  const result: FlowResult = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "na" && !NOT_REQUIRED.has(c.id))
      ? "inconclusive"
      : "pass";
  return { result, pass: result === "pass", checks };
}
