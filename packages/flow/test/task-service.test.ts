// TaskService tests (T02) — the application layer driven directly over the real TaskFileStore (no MCP
// adapter). Proves the orchestration: lockedBy always set on assign (AC3), version stamped + re-stamped
// on every write (AC4/AC5), sequential numbering from a pure-file scan (ADR-001), and not-found as a
// typed outcome (never a throw) for assign/status/get on a missing task.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { TaskFileStore } from "../src/persistence/task-file-store.js";
import { TaskService } from "../src/application/task-service.js";

const RUN = "demo-run-001";
let cwd: string;
let service: TaskService;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "flow-task-svc-"));
  service = new TaskService(new TaskFileStore(cwd));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

test("create: seeds status 'todo', stamps a version, reports tasks/NNN-<slug>.md (AC5)", () => {
  const r = service.create(RUN, "My First Task", "the body");
  assert.equal(r.taskNo, "001");
  assert.ok(typeof r.version === "string" && r.version.length > 0, "version is stamped (AC5)");
  assert.equal(r.path, "tasks/001-my-first-task.md");
  const got = service.get(RUN, "001");
  assert.ok(got.ok);
  assert.equal(got.ok && got.value.task.frontmatter.status, "todo");
});

test("create: numbers sequentially from the existing files (ADR-001 pure-file scan)", () => {
  assert.equal(service.create(RUN, "a", "").taskNo, "001");
  assert.equal(service.create(RUN, "b", "").taskNo, "002");
  assert.equal(service.create(RUN, "c", "").taskNo, "003");
});

test("assign: always populates lockedBy (and assignee), preserves status + body, re-stamps (AC3/AC5)", () => {
  const created = service.create(RUN, "T", "the brief");
  const out = service.assign(RUN, "001", "agentry:implementer");
  assert.ok(out.ok);
  assert.equal(out.ok && out.value.lockedBy, "agentry:implementer", "lockedBy is set (AC3)");
  assert.ok(out.ok && out.value.version.length > 0, "assign re-stamps (AC5)");

  const got = service.get(RUN, "001");
  assert.ok(got.ok);
  if (got.ok) {
    assert.equal(got.value.task.frontmatter.lockedBy, "agentry:implementer");
    assert.equal(got.value.task.frontmatter.assignee, "agentry:implementer");
    assert.equal(got.value.task.frontmatter.status, "todo", "status preserved through assign");
    assert.equal(got.value.task.body, "the brief", "body preserved through assign");
    assert.notEqual(got.value.task.frontmatter.version, created.version, "version changed on the assign write");
  }
});

test("status: sets the new status, preserves lockedBy, re-stamps a different version (AC5)", () => {
  service.create(RUN, "T", "x");
  const assigned = service.assign(RUN, "001", "agent-a");
  const v1 = assigned.ok ? assigned.value.version : "";

  const moved = service.status(RUN, "001", "in-progress");
  assert.ok(moved.ok);
  assert.equal(moved.ok && moved.value.status, "in-progress");
  assert.notEqual(moved.ok && moved.value.version, v1, "status re-stamps a new version (AC5)");

  const got = service.get(RUN, "001");
  assert.ok(got.ok && got.value.task.frontmatter.lockedBy === "agent-a", "lockedBy preserved through a status move");
});

test("artifact: stamps a tool-computed version; a body edit yields a different version (AC4)", () => {
  const first = service.artifact(RUN, "spec", "first body");
  assert.equal(first.path, "spec.md");
  assert.ok(first.version.length > 0);
  const edited = service.artifact(RUN, "plan", "first body"); // same body, different kind → different hash
  assert.notEqual(first.version, edited.version, "the kind is part of the hashed frontmatter");

  const specV1 = service.artifact(RUN, "spec", "edited spec body");
  assert.notEqual(first.version, specV1.version, "editing the spec body changes its version (AC4)");
});

test("list: returns created tasks from a fresh directory read, sorted by number", () => {
  service.create(RUN, "One", "a");
  service.create(RUN, "Two", "b");
  const { tasks } = service.list(RUN);
  assert.deepEqual(
    tasks.map((t) => t.taskNo),
    ["001", "002"],
  );
});

test("list: an empty run reads as no tasks (no directory yet)", () => {
  assert.deepEqual(service.list(RUN).tasks, []);
});

test("assign/status/get on a missing task → a not-found outcome (never a throw)", () => {
  const a = service.assign(RUN, "099", "x");
  const s = service.status(RUN, "099", "done");
  const g = service.get(RUN, "099");
  for (const o of [a, s, g]) {
    assert.equal(o.ok, false);
    assert.equal(o.ok === false && o.reason, "not-found");
    assert.equal(o.ok === false && o.id, "099");
  }
});
