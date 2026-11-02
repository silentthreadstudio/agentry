// Tests for the flow-compliance dimension (ADR-004 / AC7) — ZERO live API by construction: the probe is a
// read-only assertion over an already-produced run dir, so every test drives it over committed replay fixtures
// or a REAL captured `/agentry:go` trace on disk. No runner, no judge, no subprocess.
//
// Coverage:
//   - pure assertions (`assertions.ts`) over synthetic traces — each of the four checks, pass + fail.
//   - the probe (`probe.ts`) over the replay fixtures: PASS on the compliant run, FAIL on EACH of the four
//     violations, with the failing check identified.
//   - the AC7 REAL-TRACE assertion: the probe pointed at a real on-disk run dir
//     (`.agentry/work/build-agentry-workbench-…/`) — a genuine `/agentry:go` trace, not a canned fixture.

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { shapeAwareCompliance } from "../src/conduct/compliance.ts";
import {
  checkNoSkipFlag,
  checkRunStartBeforeDispatch,
  checkSingleFrontmatter,
  checkSpecBeforeTasks,
  countFrontmatterBlocks,
  runAllChecks,
  runExists,
} from "../src/honesty/flow-compliance/assertions.ts";
import { runFlowComplianceProbe } from "../src/honesty/flow-compliance/probe.ts";
import type { RunTrace, TraceEvent } from "../src/honesty/flow-compliance/trace.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "flow-compliance");
// The repo's real `.agentry/work/` (four dirs up: test/ → eval/ → packages/ → repo-root). The AC7 real-trace.
const REPO_ROOT = join(HERE, "..", "..", "..");
const REAL_RUN_DIR = join(
  REPO_ROOT,
  ".agentry",
  "work",
  "build-agentry-workbench-the-agentry-agent-center-5s9v6deiit",
);

/** A minimal synthetic trace; override fields per assertion test. */
function trace(over: Partial<RunTrace> = {}): RunTrace {
  return {
    runDir: "/synthetic",
    hasRunState: false,
    roster: [],
    events: [],
    hasSpec: false,
    specMtimeMs: null,
    hasPlan: false,
    taskFiles: [],
    ...over,
  };
}

const flowLine = (ts: string): TraceEvent => ({ ts, type: "routing-decision" });
const dispatchLine = (ts: string): TraceEvent => ({ ts, kind: "agent-started" });
const skipLine = (ts: string): TraceEvent => ({ ts, kind: "flow-skipped", artifact: "task" });

// --- pure assertions: check 1 — run_start-before-dispatch --------------------------------------------------------

test("check1: FLOW run_start strictly before first dispatch ⇒ pass", () => {
  const c = checkRunStartBeforeDispatch(
    trace({ events: [flowLine("2026-01-01T00:00:00Z"), dispatchLine("2026-01-01T00:01:00Z")] }),
  );
  assert.equal(c.status, "pass");
});

test("check1: dispatch with no preceding FLOW line ⇒ fail (the proven bypass)", () => {
  // dispatch first, FLOW line later ⇒ run_start does not precede dispatch.
  const c = checkRunStartBeforeDispatch(
    trace({ events: [dispatchLine("2026-01-01T00:00:00Z"), flowLine("2026-01-01T00:01:00Z")] }),
  );
  assert.equal(c.status, "fail");
});

test("check1: dispatch with NO FLOW line anywhere ⇒ fail", () => {
  const c = checkRunStartBeforeDispatch(trace({ events: [dispatchLine("2026-01-01T00:00:00Z")] }));
  assert.equal(c.status, "fail");
});

test("check1: no dispatch evidence at all ⇒ N/A, never a pass", () => {
  const c = checkRunStartBeforeDispatch(trace({ events: [flowLine("2026-01-01T00:00:00Z")] }));
  assert.equal(c.status, "na");
});

test("check1: roster-only evidence cannot show dispatch order ⇒ N/A, whatever the stamps say", () => {
  // `since` is restamped on every state change and agent_state needs run_start's handle, so no roster stamp
  // orders a dispatch against run_start: later, earlier or undated, the check is unobservable.
  const events = [flowLine("2026-01-01T00:01:00Z")];
  for (const since of ["2026-01-01T00:02:00Z", "2026-01-01T00:00:00Z", undefined]) {
    const c = checkRunStartBeforeDispatch(
      trace({ events, roster: [{ agent: "a", ...(since ? { since } : {}) }] }),
    );
    assert.equal(c.status, "na", `since=${since}`);
  }
});

test("runAllChecks: a required check N/A ⇒ inconclusive (not pass); a fail still wins", () => {
  const noDispatch = runAllChecks(trace({ events: [flowLine("2026-01-01T00:00:00Z")] }));
  assert.equal(noDispatch.result, "inconclusive");
  assert.equal(noDispatch.pass, false);
  const failed = runAllChecks(trace({ events: [dispatchLine("2026-01-01T00:00:00Z")] }));
  assert.equal(failed.result, "fail");
});

test("check1: a backstop-only line (kind, no type) is NOT a run_start signal", () => {
  // Only a flow-skipped backstop + a dispatch ⇒ no FLOW line precedes the dispatch ⇒ fail.
  const c = checkRunStartBeforeDispatch(
    trace({ events: [skipLine("2026-01-01T00:00:00Z"), dispatchLine("2026-01-01T00:01:00Z")] }),
  );
  assert.equal(c.status, "fail");
});

// --- pure assertions: check 2 — spec-before-tasks ----------------------------------------------------------------

test("check2: spec mtime older than first task ⇒ pass", () => {
  const c = checkSpecBeforeTasks(
    trace({
      hasSpec: true,
      specMtimeMs: 1000,
      taskFiles: [{ name: "001.md", text: "", mtimeMs: 2000 }],
    }),
  );
  assert.equal(c.status, "pass");
});

test("check2: a task file present but spec.md absent ⇒ fail", () => {
  const c = checkSpecBeforeTasks(
    trace({
      hasSpec: false,
      specMtimeMs: null,
      taskFiles: [{ name: "001.md", text: "", mtimeMs: 2000 }],
    }),
  );
  assert.equal(c.status, "fail");
});

test("check2: spec NEWER than the first task ⇒ fail", () => {
  const c = checkSpecBeforeTasks(
    trace({
      hasSpec: true,
      specMtimeMs: 5000,
      taskFiles: [{ name: "001.md", text: "", mtimeMs: 2000 }],
    }),
  );
  assert.equal(c.status, "fail");
});

test("check2: no task files ⇒ vacuously pass", () => {
  assert.equal(checkSpecBeforeTasks(trace({ hasSpec: true, specMtimeMs: 1 })).status, "pass");
});

// --- pure assertions: check 3 — single-frontmatter (the frontmatter counter) -------------------------------------

test("countFrontmatterBlocks: one leading ---…--- block ⇒ 1", () => {
  assert.equal(countFrontmatterBlocks("---\ntitle: x\n---\n\n## Goal\nbody\n"), 1);
});

test("countFrontmatterBlocks: a second stacked ---…--- block ⇒ 2", () => {
  assert.equal(countFrontmatterBlocks("---\ntitle: x\n---\n\n---\ntitle: y\n---\n\nbody\n"), 2);
});

test("countFrontmatterBlocks: no leading frontmatter ⇒ 0", () => {
  assert.equal(countFrontmatterBlocks("# just a heading\nbody\n"), 0);
});

test("countFrontmatterBlocks: em-dashes / horizontal rules in body do NOT count as a fence", () => {
  // A `---` only counts as a fence when it opens at the very start (or immediately after a closed block).
  assert.equal(
    countFrontmatterBlocks(
      "---\ntitle: x\n---\n\nbody — with an em-dash and a thematic break below\n\nsome text\n",
    ),
    1,
  );
});

test("check3: every task has exactly one frontmatter block ⇒ pass", () => {
  const c = checkSingleFrontmatter(
    trace({ taskFiles: [{ name: "001.md", text: "---\nt: 1\n---\nbody\n", mtimeMs: 1 }] }),
  );
  assert.equal(c.status, "pass");
});

test("check3: a stacked-frontmatter task ⇒ fail, naming the file", () => {
  const c = checkSingleFrontmatter(
    trace({
      taskFiles: [{ name: "001-bad.md", text: "---\nt: 1\n---\n\n---\nt: 2\n---\n", mtimeMs: 1 }],
    }),
  );
  assert.equal(c.status, "fail");
  assert.match(c.detail, /001-bad\.md/);
});

// --- pure assertions: check 4 — no-skip-flag + the run-existence floor --------------------------------------------

test("runExists: run-state.json present ⇒ a run exists", () => {
  assert.equal(runExists(trace({ hasRunState: true })), true);
});

test("runExists: a FLOW (type) line ⇒ a run exists", () => {
  assert.equal(runExists(trace({ events: [flowLine("2026-01-01T00:00:00Z")] })), true);
});

test("runExists: a backstop-only events.jsonl (only kind lines) does NOT count as a run", () => {
  assert.equal(
    runExists(
      trace({ events: [skipLine("2026-01-01T00:00:00Z"), dispatchLine("2026-01-01T00:01:00Z")] }),
    ),
    false,
  );
});

test("check4: no-skip-flag is N/A (hook retired), with or without a flow-skipped marker", () => {
  const clean = checkNoSkipFlag(trace({ events: [flowLine("2026-01-01T00:00:00Z")] }));
  const marked = checkNoSkipFlag(
    trace({ events: [flowLine("2026-01-01T00:00:00Z"), skipLine("2026-01-01T00:05:00Z")] }),
  );
  for (const c of [clean, marked]) {
    assert.equal(c.status, "na");
    assert.equal(c.detail, "N/A (hook retired)");
  }
});

// --- the probe over the committed replay fixtures: PASS on compliant, FAIL on each violation ---------------------

/**
 * Copy a fixture into a fresh temp dir so the test can stamp DETERMINISTIC mtimes (git checkout / write-order
 * mtimes are arbitrary), then return the copy's path. Whenever the fixture has a `spec.md`, it is stamped OLDER
 * than every task file so the spec-before-tasks ordering holds by construction — the ONLY fixture meant to fail
 * check 2 is `tasks-before-spec`, which carries no `spec.md` at all (so there is nothing to stamp).
 */
function stagedFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `flowcomp-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  const specPath = join(dir, "spec.md");
  if (existsSync(specPath)) {
    const old = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-01-02T00:00:00Z");
    utimesSync(specPath, old, old);
    for (const f of readdirSync(join(dir, "tasks")))
      utimesSync(join(dir, "tasks", f), newer, newer);
  }
  return dir;
}

/** Run the probe over a staged run dir and return its verdict artifact. */
function probeOver(runDir: string): ReturnType<typeof runFlowComplianceProbe>["artifact"] {
  const outPath = join(mkdtempSync(join(tmpdir(), "flowcomp-out-")), "flow-compliance.json");
  return runFlowComplianceProbe({ runDir, outPath }).artifact;
}

test("probe: the compliant fixture ⇒ PASS (all four checks green)", () => {
  const a = probeOver(stagedFixture("compliant"));
  assert.equal(a.result, "pass", JSON.stringify(a.checks, null, 2));
  assert.equal(a.pass, true);
  assert.ok(a.checks.every((c) => c.status !== "fail"));
});

test("probe: dispatch-before-run ⇒ FAIL on check 1 only", () => {
  const a = probeOver(stagedFixture("dispatch-before-run"));
  assert.equal(a.pass, false);
  const failing = a.checks.filter((c) => c.status === "fail").map((c) => c.id);
  assert.deepEqual(failing, ["run-start-before-dispatch"]);
});

/** Write a Flow roster (`run-state.json`) into a staged run dir; `since` per agent id. */
function writeRoster(dir: string, agents: Record<string, { since?: string }>): void {
  const body = Object.fromEntries(
    Object.entries(agents).map(([id, e]) => [id, { state: "working", ...e }]),
  );
  writeFileSync(join(dir, "run-state.json"), JSON.stringify({ agents: body }));
}

test("probe: no events.jsonl and no roster ⇒ check 1 N/A and the overall verdict is inconclusive, not PASS", () => {
  // Regression: dispatch was unobservable, yet the aggregate used to read "no check failed" ⇒ PASS.
  const dir = stagedFixture("dispatch-before-run");
  rmSync(join(dir, "events.jsonl"));
  const a = probeOver(dir);
  const c1 = a.checks.find((c) => c.id === "run-start-before-dispatch");
  assert.equal(c1?.status, "na");
  assert.equal(a.result, "inconclusive");
  assert.equal(a.pass, false);
});

test("shapeAwareCompliance: an inconclusive escalated run is not reported as flow-compliant", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "flowcomp-sandbox-"));
  const runDir = join(sandbox, ".agentry", "work", "r1");
  cpSync(stagedFixture("dispatch-before-run"), runDir, {
    recursive: true,
    preserveTimestamps: true,
  });
  rmSync(join(runDir, "events.jsonl"));
  const v = shapeAwareCompliance("decompose+verify", sandbox);
  assert.equal(v.pass, false);
  assert.match(v.detail, /inconclusive/);
  assert.doesNotMatch(v.detail, /flow-compliant/);
});

/** The verdict over a staged `compliant` run whose events and roster are replaced (roster-only dispatch evidence). */
function rosterRun(events: object[], agents: Record<string, { since?: string }>) {
  const dir = stagedFixture("compliant");
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  writeRoster(dir, agents);
  return probeOver(dir);
}

const routing = { ts: "2026-06-19T22:09:39.686Z", type: "routing-decision" };
const implementer = { "agentry:implementer": { since: "2026-06-19T22:19:52.108Z" } };

test("probe: dispatch before run_start, then the normal recording ⇒ inconclusive, not pass (B2)", () => {
  // run_start writes no event and a roster entry only postdates it, so a roster stamped after the first FLOW
  // line looks the same as a run that dispatched first. The verdict must not vouch for it.
  const a = rosterRun([routing], implementer);
  assert.equal(a.result, "inconclusive");
  assert.equal(a.pass, false);
  assert.equal(a.checks.find((c) => c.id === "run-start-before-dispatch")?.status, "na");
});

test("probe: run_start then agent_state with no event ⇒ inconclusive, not fail (B6)", () => {
  const a = rosterRun([], implementer);
  assert.equal(a.result, "inconclusive");
  assert.equal(a.pass, false);
});

test("probe: the verdict is stable as the run proceeds (working, event emitted, agent done)", () => {
  const working = { "agentry:implementer": { since: "2026-06-19T22:10:00.000Z" } };
  const done = { "agentry:implementer": { since: "2026-06-19T22:30:00.000Z" } };
  assert.deepEqual(
    [rosterRun([], working), rosterRun([routing], working), rosterRun([routing], done)].map(
      (a) => a.result,
    ),
    ["inconclusive", "inconclusive", "inconclusive"],
  );
});

test("probe: N/A checks emit no observer event (neither task-done nor gate-fired)", () => {
  const events: string[] = [];
  const outPath = join(mkdtempSync(join(tmpdir(), "flowcomp-out-")), "flow-compliance.json");
  runFlowComplianceProbe({
    runDir: stagedFixture("skip-flag"),
    outPath,
    observer: { emit: (e) => events.push(e.detail ?? "") },
  });
  assert.ok(events.length > 0);
  assert.ok(events.every((d) => !d.includes("N/A") && !d.startsWith("no-skip-flag")));
});

test("probe: tasks-before-spec ⇒ FAIL on check 2 only", () => {
  const a = probeOver(stagedFixture("tasks-before-spec"));
  assert.equal(a.pass, false);
  const failing = a.checks.filter((c) => c.status === "fail").map((c) => c.id);
  assert.deepEqual(failing, ["spec-before-tasks"]);
});

test("probe: double-frontmatter ⇒ FAIL on check 3 only", () => {
  const a = probeOver(stagedFixture("double-frontmatter"));
  assert.equal(a.pass, false);
  const failing = a.checks.filter((c) => c.status === "fail").map((c) => c.id);
  assert.deepEqual(failing, ["single-frontmatter"]);
});

test("probe: a skip-flag fixture still passes; no-skip-flag N/A alone is not inconclusive", () => {
  const a = probeOver(stagedFixture("skip-flag"));
  assert.equal(a.result, "pass");
  assert.equal(a.pass, true);
  const c4 = a.checks.find((c) => c.id === "no-skip-flag");
  assert.equal(c4?.status, "na");
});

// (The former `run flow-compliance --run <dir>` CLI subcommand was removed by T-10: flow-compliance is no longer a
// standalone public subcommand — it runs inside the honesty probe over escalated run dirs. The probe is covered
// directly above (over the replay fixtures) and through the honesty surface in outcome-compliance.test.ts.)

// --- AC7: the REAL-TRACE assertion — the probe over a genuine `/agentry:go` run on disk --------------------------

test("AC7 real-trace: the probe runs over a real captured /agentry:go run dir", () => {
  // This is the disambiguator exercised on the REAL shape (not only canned fixtures): a genuine escalated run
  // whose events.jsonl carries a `routing-decision` FLOW line BEFORE the first agent-started dispatch.
  if (!existsSync(REAL_RUN_DIR)) {
    // The real run dirs are working-tree artifacts; skip rather than fail if a checkout lacks them.
    return;
  }
  const a = probeOver(REAL_RUN_DIR);

  // The load-bearing real-shape assertion: run_start fired before dispatch on a real trace — the AC7 signal.
  const c1 = a.checks.find((c) => c.id === "run-start-before-dispatch")!;
  assert.equal(c1.status, "pass", `real trace must show run_start before dispatch: ${c1.detail}`);
  const c4 = a.checks.find((c) => c.id === "no-skip-flag")!;
  assert.equal(c4.status, "na");
});

// --- the aggregate verdict is the conjunction of all four checks --------------------------------------------------

test("runAllChecks: pass iff every check passes", () => {
  const allGreen = runAllChecks(
    trace({
      hasRunState: true,
      events: [flowLine("2026-01-01T00:00:00Z"), dispatchLine("2026-01-01T00:01:00Z")],
      hasSpec: true,
      specMtimeMs: 1,
      taskFiles: [{ name: "001.md", text: "---\nt: 1\n---\n", mtimeMs: 2 }],
    }),
  );
  assert.equal(allGreen.result, "pass");
  assert.equal(allGreen.pass, true);
  assert.equal(allGreen.checks.length, 4);
});
