// Monitor family (AC8) — the conductor lifecycle stream + the run front door. Exercises RunService
// over the REAL file-store adapters (a tmp cwd), so the EventLog append + parseLogLine read seam is
// the one that ships. AC8: routing-decision/gate/node-enter/node-done (with durationMs) round-trip
// through emit → tail as typed FlowEvent lines. Also pins the front-door scaffold, emit rejection,
// and the empty-agent / both-shapes tail filtering.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FlowEvent } from "../src/domain/events.js";
import { createServices } from "../src/index.js";
import { RunService } from "../src/application/run-service.js";

let cwd: string;
let service: RunService;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "flow-monitor-"));
  service = new RunService(createServices(cwd));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ── run_start (the front door, ADR-005 NO branch) ───────────────────────────────────────────────

test("run_start mints a run, creates the run dir + a version-stamped spec scaffold", () => {
  const { run } = service.start({ goal: "ship the widget" });

  assert.ok(run.startsWith("ship-the-widget-"), "run id is slugged from the goal");
  const specPath = join(cwd, ".agentry", "work", run, "spec.md");
  assert.ok(existsSync(specPath), "spec.md scaffold exists");
  const spec = readFileSync(specPath, "utf8");
  assert.match(spec, /^---\n[\s\S]*version:[\s\S]*\n---\n/, "spec is version-stamped frontmatter");
  assert.match(spec, /Acceptance criteria/, "scaffold carries the spec skeleton");
});

test("run_start honors an explicit run handle instead of minting", () => {
  const { run } = service.start({ run: "given-run-001" });
  assert.equal(run, "given-run-001");
  assert.ok(existsSync(join(cwd, ".agentry", "work", "given-run-001")));
});

test("run_start writes the session pointer ONLY when session_id is passed", () => {
  const sid = "sess-abc";
  const { run } = service.start({ goal: "g", session_id: sid });
  const ptr = JSON.parse(readFileSync(join(cwd, ".agentry", "run", "sessions", `${sid}.json`), "utf8"));
  assert.equal(ptr.workId, run, "pointer binds the session to the minted run");
});

test("run_start does NOT write a session pointer when session_id is absent (binder seeds it reactively)", () => {
  service.start({ goal: "g" });
  assert.ok(!existsSync(join(cwd, ".agentry", "run", "sessions")), "no pointer dir without session_id");
});

// ── AC8 — the conductor is the primary emitter ──────────────────────────────────────────────────

test("AC8: routing-decision / gate / node-enter / node-done(durationMs) round-trip through emit → tail", () => {
  const { run } = service.start({ goal: "escalated run" });

  assert.deepEqual(
    service.emit(run, { ts: "2026-01-01T00:00:00.000Z", type: "routing-decision", shape: "decompose", kind: "feature" }),
    { ok: true },
  );
  service.emit(run, { ts: "2026-01-01T00:00:01.000Z", type: "gate", gate: "plan", outcome: "approved" });
  service.emit(run, { ts: "2026-01-01T00:00:02.000Z", type: "node-enter", node: "T03", agent: "agentry:implementer" });
  service.emit(run, { ts: "2026-01-01T00:00:03.000Z", type: "node-done", node: "T03", durationMs: 4200 });

  const { events } = service.tail(run);
  assert.equal(events.length, 4, "all four conductor lifecycle lines round-trip");

  // Every line validates against the closed FlowEvent union (the typed vocabulary, not the hook shape).
  for (const ev of events) assert.doesNotThrow(() => FlowEvent.parse(ev));

  const byType = Object.fromEntries(events.map((e) => [e.type, e]));
  assert.equal(byType["routing-decision"].shape, "decompose");
  assert.equal(byType["routing-decision"].kind, "feature");
  assert.equal(byType["gate"].gate, "plan");
  assert.equal(byType["node-enter"].agent, "agentry:implementer");
  assert.equal(byType["node-done"].durationMs, 4200, "node-done carries durationMs (AC8)");
});

test("event_emit rejects an out-of-union type (closed vocabulary, AC8)", () => {
  const { run } = service.start({ goal: "g" });
  const outcome = service.emit(run, { ts: "2026-01-01T00:00:00.000Z", type: "totally-made-up" });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.field, "type");

  // A rejected emit never reaches the stream.
  assert.equal(service.tail(run).events.length, 0);
});

// ── event_tail reads both shapes + filters the empty-agent main-session line ─────────────────────

test("event_tail returns only typed FLOW events — hook lines and empty-agent lines are filtered", () => {
  const { run } = service.start({ goal: "g" });
  service.emit(run, { ts: "2026-01-01T00:00:02.000Z", type: "node-enter", node: "T01", agent: "agentry:explorer" });

  // Append raw lines straight to the file: a real hook backstop line (kept parseable, but not a FLOW
  // event so it won't appear in the typed tail) and an empty-agent main-session line (filtered).
  const log = join(cwd, ".agentry", "work", run, "events.jsonl");
  appendFileSync(log, `${JSON.stringify({ ts: "2026-01-01T00:00:03.000Z", kind: "agent-started", agent: "agentry:explorer" })}\n`);
  appendFileSync(log, `${JSON.stringify({ ts: "2026-01-01T00:00:04.000Z", kind: "agent-started", agent: "" })}\n`);

  const { events } = service.tail(run);
  assert.equal(events.length, 1, "only the one FLOW node-enter is a typed event");
  assert.equal(events[0].type, "node-enter");
});

test("event_tail honors the `since` filter", () => {
  const { run } = service.start({ goal: "g" });
  service.emit(run, { ts: "2026-01-01T00:00:00.000Z", type: "gate", gate: "spec", outcome: "reached" });
  service.emit(run, { ts: "2026-06-01T00:00:00.000Z", type: "gate", gate: "ship", outcome: "approved" });

  const { events } = service.tail(run, "2026-03-01T00:00:00.000Z");
  assert.equal(events.length, 1, "only the line at/after `since` is returned");
  assert.equal(events[0].gate, "ship");
});

// ── run_get / run_status task summary ────────────────────────────────────────────────────────────

test("run_get returns the run state (empty object before any state is written)", () => {
  const { run } = service.start({ goal: "g" });
  assert.deepEqual(service.get(run), { run, state: {} });
});

test("run_status summarizes tasks by status", () => {
  const cwdServices = createServices(cwd);
  const { run } = new RunService(cwdServices).start({ goal: "g" });
  const tasksDir = join(cwd, ".agentry", "work", run, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  cwdServices.tasks.writeTask(run, { taskNo: "001", frontmatter: { title: "a", status: "done" }, body: "x" });
  cwdServices.tasks.writeTask(run, { taskNo: "002", frontmatter: { title: "b", status: "todo" }, body: "y" });
  cwdServices.tasks.writeTask(run, { taskNo: "003", frontmatter: { title: "c", status: "todo" }, body: "z" });

  const status = new RunService(cwdServices).status(run);
  assert.deepEqual(status.tasks, { done: 1, todo: 2 });
});
