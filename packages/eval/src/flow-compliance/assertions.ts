// The flow-compliance assertion layer — PURE predicates over a {@link RunTrace}, mirroring the routing/moat
// control gates. Zero I/O, no API: forced-testable with synthetic traces. Each of the four ordered checks
// returns a {@link Check} (pass + a human verdict); `runAllChecks` aggregates them into a {@link FlowVerdict}.
//
// The contract asserted (ADR-004, AS-BUILT shapes decided by ADR-001/B1 + the A3/C1 single-frontmatter rule):
//   1. run_start-before-dispatch — the first `type`-bearing FLOW line precedes the first `agent-started` line.
//   2. spec-before-tasks — `spec.md` exists and predates the first `tasks/NNN-*.md`.
//   3. single-frontmatter — every task file parses to exactly ONE leading `---…---` block.
//   4. no-skip-flag — no `flow-skipped` marker for an above-floor run.
//
// "A run exists" (the above-floor floor for checks 1 and 4) = `run-state.json` present OR ≥1 FLOW (`type`) line.
// A backstop-only `events.jsonl` (only `kind` lines, e.g. `flow-skipped`) does NOT count as a run.

import type { RunTrace, TraceEvent, TaskFile } from "./trace.ts";

/** The four ordered checks, in assertion order. PINNED — the artifact/verdict consume these ids verbatim. */
export const CHECK_IDS = [
  "run-start-before-dispatch",
  "spec-before-tasks",
  "single-frontmatter",
  "no-skip-flag",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** One check's result: which check, whether it passed, and a human-readable verdict (the evidence on FAIL). */
export interface Check {
  id: CheckId;
  pass: boolean;
  /** A short, evidence-bearing line — what made it pass or fail (the readable trace). */
  detail: string;
}

/** The aggregate verdict over a run: PASS iff every check passed, plus the per-check breakdown. */
export interface FlowVerdict {
  pass: boolean;
  checks: readonly Check[];
}

/** The first FLOW (`type`-bearing) line — the run-start signal. A `kind`-only backstop line is NOT one. */
function firstFlowEvent(events: readonly TraceEvent[]): TraceEvent | undefined {
  return events.find((e) => e.type !== undefined);
}

/** The first dispatch signal — the first `agent-started` backstop line (the implementer/subagent dispatch). */
function firstDispatchEvent(events: readonly TraceEvent[]): TraceEvent | undefined {
  return events.find((e) => e.kind === "agent-started");
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
 * skipped `event_emit` still has its artifacts, so it is correctly judged above-floor (and then FAILs check 1, the
 * missing routing event — rather than escaping as "sub-floor N/A").
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
 * `agent-started` line's ts. A dispatch with no preceding FLOW line = FAIL (the proven bypass made observable).
 * With no dispatch line at all, there is nothing to order against ⇒ vacuously satisfied.
 */
export function checkRunStartBeforeDispatch(trace: RunTrace): Check {
  const id: CheckId = "run-start-before-dispatch";
  const dispatch = firstDispatchEvent(trace.events);
  if (dispatch === undefined) {
    return { id, pass: true, detail: "no agent dispatch in the trace — nothing to order" };
  }
  const flow = firstFlowEvent(trace.events);
  if (flow === undefined) {
    return { id, pass: false, detail: `agent dispatched at ${dispatch.ts} with no preceding run_start/FLOW line` };
  }
  const pass = flow.ts < dispatch.ts;
  return {
    id,
    pass,
    detail: pass
      ? `run_start (${flow.type} @ ${flow.ts}) precedes first dispatch @ ${dispatch.ts}`
      : `run_start (${flow.type} @ ${flow.ts}) does NOT precede first dispatch @ ${dispatch.ts}`,
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
    return { id, pass: true, detail: "no task files — spec ordering not exercised" };
  }
  if (!trace.hasSpec || trace.specMtimeMs === null) {
    return { id, pass: false, detail: `task file ${firstTask.name} present but spec.md is absent` };
  }
  const earliestTaskMtime = Math.min(...trace.taskFiles.map((t) => t.mtimeMs));
  const pass = trace.specMtimeMs <= earliestTaskMtime;
  return {
    id,
    pass,
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
    return { id, pass: true, detail: "no task files to check" };
  }
  const offenders = trace.taskFiles
    .map((t: TaskFile) => ({ name: t.name, blocks: countFrontmatterBlocks(t.text) }))
    .filter((r) => r.blocks !== 1);
  if (offenders.length === 0) {
    return { id, pass: true, detail: `all ${trace.taskFiles.length} task file(s) have exactly one frontmatter block` };
  }
  const named = offenders.map((o) => `${o.name} (${o.blocks} blocks)`).join(", ");
  return { id, pass: false, detail: `task file(s) without exactly one frontmatter block: ${named}` };
}

/**
 * CHECK 4 — no-skip-flag. An above-floor run must carry NO `flow-skipped` marker (the B1 backstop line written
 * when a gate artifact is produced with no run). If the run is sub-floor ("no run exists"), the check is N/A and
 * passes (a one-shot writes no artifact and triggers no flag). For an above-floor run, any `flow-skipped` = FAIL.
 */
export function checkNoSkipFlag(trace: RunTrace): Check {
  const id: CheckId = "no-skip-flag";
  if (!isAboveFloor(trace)) {
    return { id, pass: true, detail: "sub-floor run (no orchestration artifacts) — skip-flag check N/A" };
  }
  const skips = trace.events.filter((e) => e.kind === "flow-skipped");
  if (skips.length === 0) {
    return { id, pass: true, detail: "no flow-skipped marker for an above-floor run" };
  }
  const named = skips.map((s) => s.artifact ?? "?").join(", ");
  return { id, pass: false, detail: `${skips.length} flow-skipped marker(s) for an above-floor run: ${named}` };
}

/** Run all four checks in order and aggregate — PASS iff every check passed. */
export function runAllChecks(trace: RunTrace): FlowVerdict {
  const checks: Check[] = [
    checkRunStartBeforeDispatch(trace),
    checkSpecBeforeTasks(trace),
    checkSingleFrontmatter(trace),
    checkNoSkipFlag(trace),
  ];
  return { pass: checks.every((c) => c.pass), checks };
}
