// Persistence (AC6) — the file-store adapters are the ONLY state holder. Write via an adapter, drop
// the instance, build a FRESH adapter, re-read → identical content. No orchestration state lives only
// in the server. Also pins the tool-stamped version (AC4/AC5) and the closed-event append (ADR-002).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { JsonlEventLog } from "../src/persistence/event-log.js";
import { JsonReviewStore } from "../src/persistence/review-store.js";
import { JsonRunStateStore } from "../src/persistence/run-state-store.js";
import { TaskFileStore } from "../src/persistence/task-file-store.js";

const RUN = "demo-run-001";
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "flow-persist-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

test("TaskFileStore: a task written by one adapter is read identically by a fresh adapter", () => {
  new TaskFileStore(cwd).writeTask(RUN, {
    taskNo: "001",
    frontmatter: { title: "Foundation", status: "todo", lockedBy: "agentry:implementer" },
    body: "the task brief",
  });
  const fresh = new TaskFileStore(cwd).readTask(RUN, "001"); // adapter instance dropped
  assert.ok(fresh);
  assert.equal(fresh.frontmatter.status, "todo");
  assert.equal(fresh.frontmatter.lockedBy, "agentry:implementer");
  assert.equal(fresh.body, "the task brief");
});

test("TaskFileStore stamps a version the caller never supplied, and it changes on a body edit (AC4/AC5)", () => {
  const store = new TaskFileStore(cwd);
  store.writeTask(RUN, { taskNo: "002", frontmatter: { title: "v", version: "CALLER-FAKE" }, body: "first" });
  const v1 = new TaskFileStore(cwd).readTask(RUN, "002")?.frontmatter.version;
  assert.ok(typeof v1 === "string" && v1.length > 0);
  assert.notEqual(v1, "CALLER-FAKE"); // caller-supplied version is dropped and recomputed

  store.writeTask(RUN, { taskNo: "002", frontmatter: { title: "v" }, body: "second — edited body" });
  const v2 = new TaskFileStore(cwd).readTask(RUN, "002")?.frontmatter.version;
  assert.notEqual(v1, v2);
});

test("TaskFileStore: one file per task number (a renamed task leaves no stale sibling)", () => {
  const store = new TaskFileStore(cwd);
  store.writeTask(RUN, { taskNo: "003", frontmatter: { title: "Old Title" }, body: "x" });
  store.writeTask(RUN, { taskNo: "003", frontmatter: { title: "New Title" }, body: "x" });
  const files = readdirSync(join(cwd, ".agentry", "work", RUN, "tasks")).filter((f) => f.startsWith("003-"));
  assert.equal(files.length, 1);
});

test("TaskFileStore: artifact (spec/plan) round-trips body and carries a version", () => {
  new TaskFileStore(cwd).writeArtifact(RUN, "spec", "the spec body");
  assert.equal(new TaskFileStore(cwd).readArtifact(RUN, "spec"), "the spec body");
  const raw = readFileSync(join(cwd, ".agentry", "work", RUN, "spec.md"), "utf8");
  assert.match(raw, /version:/);
});

test("JsonlEventLog: appended FLOW events survive a fresh adapter and tail filters by since", () => {
  const log = new JsonlEventLog(cwd);
  log.append(RUN, { ts: "2026-06-19T10:00:00.000Z", type: "gate", gate: "spec", outcome: "reached" });
  log.append(RUN, { ts: "2026-06-19T11:00:00.000Z", type: "node-done", node: "n", durationMs: 5 });

  const all = new JsonlEventLog(cwd).tail(RUN); // fresh adapter
  assert.equal(all.length, 2);
  const recent = new JsonlEventLog(cwd).tail(RUN, "2026-06-19T10:30:00.000Z");
  assert.equal(recent.length, 1);
});

test("JsonlEventLog: rejects an event outside the closed union (no malformed line reaches the file)", () => {
  assert.throws(() => new JsonlEventLog(cwd).append(RUN, { ts: "t", type: "made-up" } as never));
});

test("JsonReviewStore: comments survive a fresh adapter; resolved is preserved", () => {
  const comment = {
    id: "c1",
    anchor: { originalText: "snippet", headingAnchor: "## Section", startLine: 12 },
    decision: "changes" as const,
    body: "fix this",
    resolved: false,
  };
  new JsonReviewStore(cwd).write(RUN, "spec", [comment]);
  const back = new JsonReviewStore(cwd).read(RUN, "spec");
  assert.equal(back.length, 1);
  assert.equal(back[0]?.resolved, false);
  assert.equal(back[0]?.anchor.startLine, 12);
});

test("JsonRunStateStore: run state survives a fresh adapter", () => {
  new JsonRunStateStore(cwd).writeRunState(RUN, { roster: { "agentry:implementer": "working" } });
  const back = new JsonRunStateStore(cwd).readRunState(RUN);
  assert.deepEqual(back, { roster: { "agentry:implementer": "working" } });
});
