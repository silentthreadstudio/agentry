// TaskService — the application layer for the Task family (the highest-leverage FLOW family). It owns
// *what each task tool does*, orchestrating the domain (version, ids) over the `TaskStore` port from
// T01. Pure of MCP/zod: the tool adapter (task-tools.ts) validates input and renders envelopes; this
// layer takes plain values, calls the port, and returns plain results or a typed outcome. Mirrors
// @agentry/memory's `MemoryService` (typed discriminated outcomes the adapter switches on — the
// service never builds an envelope and never throws for an expected failure).
//
// Three v1 failures, impossible by construction here:
//  - lockedBy never written → `assign` always sets `lockedBy` (+ `assignee`) into frontmatter (AC3).
//  - no content-hash → every write routes through the store, which stamps a tool-computed `version`
//    over (body, frontmatter-sans-version); the caller never supplies it (AC4/AC5). The service
//    drops any caller `version` before handing the record to the store, so the stamp is the only one.
//  - (the status-enum failure is closed at the zod boundary in task-tools.ts — out-of-enum is rejected
//    before the handler runs, so no invalid status reaches this layer or a file; AC2.)
import { computeVersion } from "../domain/version.js";
import { formatTaskNo } from "../domain/ids.js";
import type { FlowTaskStatus } from "../domain/status.js";
import type { ArtifactKind, FlowTask, TaskStore } from "../domain/ports.js";

// A task's lifecycle status is the closed `FlowTaskStatus` enum (todo|in-progress|in-review|done) —
// the zod boundary rejects anything else (AC2), so this layer only ever sees a valid value.
type TaskStatus = FlowTaskStatus;

// The result the adapter renders on the happy path. `version` is the tool-stamped content-hash the
// store wrote (re-read from the persisted record), so the caller sees exactly what landed on disk.
export interface TaskWriteResult {
  taskNo: string;
  version: string;
}

// `not-found` is the one expected failure these ops can hit (assign/status/get a task that was never
// created). Returned as a typed outcome, switched to a `notFound` envelope by the adapter — never an
// envelope built here (mirrors MemoryService).
export type TaskOutcome<T> = { ok: true; value: T } | { ok: false; reason: "not-found"; id: string };

export class TaskService {
  constructor(private readonly store: TaskStore) {}

  // Create the next task file. The number is derived from the existing files (pure-file scan, ADR-001):
  // max existing NNN + 1, zero-padded. `status` seeds to "todo" (the enum's entry state, ADR-004).
  create(run: string, title: string, body: string): TaskWriteResult & { path: string } {
    const taskNo = this.nextTaskNo(run);
    const frontmatter: Record<string, unknown> = { title, status: "todo" };
    return { ...this.writeTask(run, { taskNo, frontmatter, body }), path: this.taskPath(taskNo, title) };
  }

  // Assign an agent: set `lockedBy` (+ `assignee`, the human-readable alias) on the task frontmatter.
  // lockedBy is ALWAYS populated here (AC3) — there is no path that assigns without setting it. The
  // existing frontmatter/body are preserved; only the assignment fields change, then the store re-stamps.
  assign(run: string, taskNo: string, agent: string): TaskOutcome<TaskWriteResult & { lockedBy: string }> {
    const task = this.store.readTask(run, taskNo);
    if (!task) return { ok: false, reason: "not-found", id: taskNo };
    const frontmatter = { ...task.frontmatter, lockedBy: agent, assignee: agent };
    const written = this.writeTask(run, { taskNo, frontmatter, body: task.body });
    return { ok: true, value: { ...written, lockedBy: agent } };
  }

  // Move a task to a new lifecycle status. `status` is already validated against the closed enum at
  // the zod boundary (AC2), so it is always one of {todo,in-progress,in-review,done} here. Preserves
  // the rest of the frontmatter/body; the store re-stamps the version (AC5).
  status(run: string, taskNo: string, status: TaskStatus): TaskOutcome<TaskWriteResult & { status: TaskStatus }> {
    const task = this.store.readTask(run, taskNo);
    if (!task) return { ok: false, reason: "not-found", id: taskNo };
    const frontmatter = { ...task.frontmatter, status };
    const written = this.writeTask(run, { taskNo, frontmatter, body: task.body });
    return { ok: true, value: { ...written, status } };
  }

  get(run: string, taskNo: string): TaskOutcome<{ task: FlowTask }> {
    const task = this.store.readTask(run, taskNo);
    if (!task) return { ok: false, reason: "not-found", id: taskNo };
    return { ok: true, value: { task } };
  }

  list(run: string): { tasks: FlowTask[] } {
    return { tasks: this.store.listTasks(run) };
  }

  // Write a run-root artifact (spec.md|plan.md). Same version-stamping write path as a task (AC4) —
  // the store stamps the tool-computed version; editing the body and rewriting yields a different one.
  // `version` is re-read from the persisted artifact so the caller sees the stamp that landed.
  artifact(run: string, kind: ArtifactKind, body: string): { path: string; version: string } {
    this.store.writeArtifact(run, kind, body);
    return { path: `${kind}.md`, version: this.artifactVersion(kind, body) };
  }

  // Write a task through the store (which stamps the version), then re-read the persisted record so the
  // returned `version` is the one on disk — never a value this layer or the caller invented. Any
  // caller-supplied `version` in the frontmatter is dropped before the write (defense in depth; the
  // store also strips it).
  private writeTask(run: string, task: FlowTask): TaskWriteResult {
    const { version: _dropped, ...frontmatter } = task.frontmatter;
    this.store.writeTask(run, { ...task, frontmatter });
    const persisted = this.store.readTask(run, task.taskNo);
    const version = typeof persisted?.frontmatter.version === "string" ? persisted.frontmatter.version : "";
    return { taskNo: task.taskNo, version };
  }

  // The version the store stamped for an artifact body: the store hashes over (body, {kind}), so we
  // compute the same fingerprint to report it back (the store stamps `{kind}` as the only frontmatter).
  private artifactVersion(kind: ArtifactKind, body: string): string {
    return computeVersion(body, { kind });
  }

  // Next free task number: one past the highest existing NNN (pure-file scan, ADR-001). 001 for an
  // empty run. Non-numeric prefixes are ignored so a stray file can't break numbering.
  private nextTaskNo(run: string): string {
    let max = 0;
    for (const task of this.store.listTasks(run)) {
      const n = Number.parseInt(task.taskNo, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return formatTaskNo(max + 1);
  }

  // The on-disk path the create result reports — `tasks/NNN-<slug>.md`. The slug mirrors the store's
  // own `slugOf` (title → hyphenated ascii-word), so the reported path matches the file the store wrote.
  private taskPath(taskNo: string, title: string): string {
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48)
        .replace(/-+$/g, "") || "task";
    return `tasks/${taskNo}-${slug}.md`;
  }
}
