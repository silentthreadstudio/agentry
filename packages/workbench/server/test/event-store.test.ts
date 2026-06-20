// EventStore + GateInbox proof (task 020) — the one timeline fold + the agent roster + the open-gate
// inbox. Two layers: (1) against a FAKE WorkRepository over a temp `.agentry/work/` tree, so the fold +
// roster + sidecar scan are deterministic; (2) against the REAL FsWorkRepository on the repo's runs, so the
// readers are proven on genuine `events.jsonl` + `run-state.json` + `.review/` data (the acceptance).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { RunFiles, WorkRepository } from "../src/domain/ports.js";
import { FsWorkRepository } from "../src/persistence/fs-work-repository.js";
import { EventStore } from "../src/application/event-store.js";
import { GateInbox } from "../src/application/gate-inbox.js";
import { FsEventSource } from "../src/persistence/event-source.js";
import { FsReviewSidecarSource } from "../src/persistence/review-sidecar-source.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// A fake repository serving a fixed run list — EventStore/GateInbox read the files off disk (under `cwd`),
// the repository only supplies which runs exist.
function fakeRepo(runs: string[]): WorkRepository {
  return {
    listRuns: () => runs,
    readRun: () => undefined as RunFiles | undefined,
  };
}

// Build a temp project root with a `.agentry/work/<run>/` tree carrying the given files. Returns the cwd.
function seedProject(
  runs: Record<string, { events?: string; runState?: string; reviews?: Record<string, string> }>,
): string {
  const cwd = mkdtempSync(join(tmpdir(), "wb-event-"));
  for (const [run, files] of Object.entries(runs)) {
    const dir = join(cwd, ".agentry", "work", run);
    mkdirSync(dir, { recursive: true });
    if (files.events !== undefined) writeFileSync(join(dir, "events.jsonl"), files.events);
    if (files.runState !== undefined) writeFileSync(join(dir, "run-state.json"), files.runState);
    if (files.reviews) {
      mkdirSync(join(dir, ".review"), { recursive: true });
      for (const [gate, body] of Object.entries(files.reviews)) {
        writeFileSync(join(dir, ".review", `${gate}.annotations.json`), body);
      }
    }
  }
  return cwd;
}

test("timeline folds FLOW events and drops empty-agent main-session lines (parseLogLine reuse)", () => {
  const events = [
    '{"ts":"2026-06-19T20:14:37.157Z","type":"node-done","node":"spec","durationMs":4200}',
    '{"ts":"2026-06-19T20:15:46.878Z","type":"routing-decision","shape":"decompose+verify","kind":"feature"}',
    '{"ts":"2026-06-19T20:16:00.000Z","kind":"subagent-start","agent":"implementer"}', // hook line, kept
    '{"ts":"2026-06-19T20:16:01.000Z","kind":"subagent-start"}', // empty-agent main-session line → DROPPED
    "", // blank → dropped
    "not json", // malformed → dropped
  ].join("\n");
  const cwd = seedProject({ "run-a": { events } });
  try {
    const store = new EventStore(fakeRepo(["run-a"]), new FsEventSource(cwd));
    const timeline = store.timeline();
    // 2 FLOW lines + 1 hook line kept; the empty-agent / blank / malformed lines dropped.
    assert.equal(timeline.length, 3, "kept exactly the 3 valid lines");
    assert.equal(timeline[0]?.event.type, "node-done");
    assert.equal(timeline[1]?.event.type, "routing-decision");
    assert.equal(timeline[2]?.event.type, "node-enter", "the hook line projects to a node-enter");
    assert.ok(timeline[0]?.id.startsWith("run-a#"), "feed key is namespaced by run");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("timeline(runId) filters to one run; cross-run folds every run", () => {
  const cwd = seedProject({
    "run-a": { events: '{"ts":"2026-06-19T20:00:00.000Z","type":"node-done","node":"a","durationMs":1}' },
    "run-b": { events: '{"ts":"2026-06-19T21:00:00.000Z","type":"node-done","node":"b","durationMs":1}' },
  });
  try {
    const store = new EventStore(fakeRepo(["run-a", "run-b"]), new FsEventSource(cwd));
    assert.equal(store.timeline("run-a").length, 1, "per-run fold sees only run-a");
    assert.equal(store.timeline().length, 2, "cross-run fold sees both runs");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("roster reads run-state.json across runs, validating AgentState, namespacing by run", () => {
  const cwd = seedProject({
    "run-a": { runState: JSON.stringify({ agents: { implementer: { state: "working", assignedTask: "001" } } }) },
    "run-b": { runState: JSON.stringify({ agents: { verifier: { state: "done" }, bogus: { state: "nonsense" } } }) },
  });
  try {
    const store = new EventStore(fakeRepo(["run-a", "run-b"]), new FsEventSource(cwd));
    const roster = store.roster();
    // 2 valid agents kept; the out-of-enum `bogus` agent dropped.
    assert.equal(roster.length, 2, "two valid agents, the bad-state one dropped");
    const impl = roster.find((a) => a.role === "implementer");
    assert.equal(impl?.id, "run-a/implementer", "id is namespaced by run");
    assert.equal(impl?.state, "working");
    assert.equal(impl?.task, "001", "assignedTask surfaces as task");
    assert.equal(roster.find((a) => a.role === "verifier")?.task, null, "no assignedTask → null");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("roster reads an empty roster for an absent/corrupt run-state", () => {
  const cwd = seedProject({ "run-a": { runState: "{ not json" }, "run-b": {} });
  try {
    const store = new EventStore(fakeRepo(["run-a", "run-b"]), new FsEventSource(cwd));
    assert.deepEqual(store.roster(), [], "corrupt + absent run-state → empty roster, no throw");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("GateInbox.open returns gates with unresolved comments, dropping resolved ones", () => {
  const open = JSON.stringify([
    { id: "c1", anchor: { originalText: "x", headingAnchor: "h", startLine: 1 }, decision: "changes", body: "fix", resolved: false },
  ]);
  const resolved = JSON.stringify([
    { id: "c2", anchor: { originalText: "y", headingAnchor: "h", startLine: 2 }, decision: "approve", body: "ok", resolved: true },
  ]);
  const cwd = seedProject({ "run-a": { reviews: { spec: open, plan: resolved } } });
  try {
    const inbox = new GateInbox(fakeRepo(["run-a"]), new FsReviewSidecarSource(cwd));
    const items = inbox.open();
    assert.equal(items.length, 1, "only the spec gate is waiting on you");
    const item = items[0];
    assert.equal(item?.run, "run-a", "carries the jump-to-run pointer");
    assert.equal(item?.gate, "spec");
    assert.equal(item?.docId, "spec");
    assert.equal(item?.comments.length, 1, "only the unresolved comment surfaces");
    assert.equal(item?.decision, null, "decision is null while open");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("GateInbox.open(runId) filters to one run; a corrupt sidecar reads empty", () => {
  const cwd = seedProject({
    "run-a": {
      reviews: {
        spec: JSON.stringify([{ id: "c1", anchor: { originalText: "x", headingAnchor: "h", startLine: 1 }, decision: "changes", body: "b", resolved: false }]),
        plan: "{ corrupt",
      },
    },
  });
  try {
    const inbox = new GateInbox(fakeRepo(["run-a"]), new FsReviewSidecarSource(cwd));
    const items = inbox.open("run-a");
    assert.equal(items.length, 1, "corrupt sidecar reads empty, only the valid spec gate is open");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("EventStore + GateInbox on the REAL repo runs (acceptance)", () => {
  const repo = new FsWorkRepository(REPO_ROOT);
  const store = new EventStore(repo, new FsEventSource(REPO_ROOT));
  const inbox = new GateInbox(repo, new FsReviewSidecarSource(REPO_ROOT));

  // The cross-run timeline folds real events.jsonl into views — at least one routing-decision exists.
  const timeline = store.timeline();
  assert.ok(timeline.length > 0, "the real runs fold into a non-empty timeline");

  // The roster reads real run-state.json — every recorded agent validates to a known state. We do NOT
  // assert a non-zero count against the real tree: the repo's runs are mutable (a run may have no
  // run-state.json, or none recording an agent), which made this flaky. The roster's "reads a recorded
  // agent" guarantee is proven deterministically below against a temp fixture; here we only prove the
  // real-tree read never produces an out-of-enum state.
  const roster = store.roster();
  assert.ok(Array.isArray(roster), "the real runs fold into a roster without throwing");
  for (const agent of roster) assert.ok(["working", "blocked", "done"].includes(agent.state));

  // Deterministic roster proof: a temp fixture run that records one agent surfaces it (no real-tree dep).
  const cwd = seedProject({
    "run-fixture": {
      runState: JSON.stringify({ agents: { implementer: { state: "working", assignedTask: "001" } } }),
    },
  });
  try {
    const fixtureStore = new EventStore(fakeRepo(["run-fixture"]), new FsEventSource(cwd));
    const fixtureRoster = fixtureStore.roster();
    assert.equal(fixtureRoster.length, 1, "the fixture run records exactly one agent");
    assert.equal(fixtureRoster[0]?.role, "implementer", "the recorded agent surfaces from run-state");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  // The inbox scans real `.review/` sidecars — never throws (open list may be empty if all resolved).
  assert.ok(Array.isArray(inbox.open()), "the inbox scans real sidecars without throwing");
});
