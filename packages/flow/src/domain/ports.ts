// Ports — the seams the application (T02–T05 services) depend on. Concrete adapters live in
// persistence/. Defined as interfaces (mirroring @agentry/memory's `ports.ts`) so the application is
// unit-testable without a real FS, and so a derived `RunIndex` can be added behind the same port
// later without touching application/ (ADR-001 — the seam is reserved, the implementation deferred).
//
// All ports are keyed by an explicit `run` (the run id, a single traversal-safe path segment). There
// is NO ambient "current run" in any port — the server is stateless w.r.t. the session (ADR-005 NO
// branch); the caller threads `run` on every call. Plain values only cross these ports — no
// `node:fs` types leak across (the domain stays pure).
import type { FlowEvent } from "./events.js";
import type { ReviewComment } from "./review.js";

// An artifact written at the run root (not under tasks/): the spec and the plan (spec §3.1 Tasks).
export type ArtifactKind = "spec" | "plan";

// A parsed task file. `frontmatter` carries the live lifecycle fields (`status`, `lockedBy`,
// `version`, …); `body` is the task prose. The store reads/writes the whole record; the application
// owns the field semantics (kept loose here so the foundation pins the seam, not the field set —
// T02 owns the task field contract).
export interface FlowTask {
  taskNo: string; // zero-padded NNN (the file prefix)
  frontmatter: Record<string, unknown>;
  body: string;
}

// Tasks + run-root artifacts (spec.md / plan.md). The Workbench-V1 seam producer (spec §3.1).
export interface TaskStore {
  readTask(run: string, taskNo: string): FlowTask | undefined;
  writeTask(run: string, task: FlowTask): void;
  listTasks(run: string): FlowTask[];
  readArtifact(run: string, kind: ArtifactKind): string | undefined;
  writeArtifact(run: string, kind: ArtifactKind, body: string): void;
}

// The append-only `events.jsonl` (ADR-002). `append` writes one validated FLOW line; `tail` reads
// the stream back (optionally only lines at/after `since`, an ISO timestamp), classified by the
// reader. Plain `FlowEvent` in, plain lines out — no fs types cross the port.
export interface EventLog {
  append(run: string, event: FlowEvent): void;
  tail(run: string, since?: string): string[];
}

// The review sidecar (spec AC10): per-gate annotation files under `.agentry/work/<run>/.review/`.
export interface ReviewStore {
  read(run: string, gate: string): ReviewComment[];
  write(run: string, gate: string, comments: ReviewComment[]): void;
}

// The run-state json (agent roster + live states; spec §3.1 Agents). Run-state is loose at this
// layer (T05 owns its field contract); `ensureRun` creates the run directory so the first write has
// a home.
export interface RunStore {
  ensureRun(run: string): void;
  readRunState(run: string): Record<string, unknown> | undefined;
  writeRunState(run: string, state: Record<string, unknown>): void;
}

// RunIndex — DECLARED-ONLY / reserved (ADR-001). No adapter ships in v1; the pure-file stores above
// are the only state holders. Declared so a future Workbench aggregate read can add a derived index
// behind a named port (a forward, additive change) rather than a rewrite. Intentionally minimal —
// the shape is fixed when (if) the first reading consumer lands.
export interface RunIndex {
  /** Reserved: rebuild the derived index from the file stores. Unused in v1 (ADR-001). */
  rebuild(run: string): void;
}
