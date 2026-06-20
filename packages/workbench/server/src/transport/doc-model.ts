// doc-model — the DocModel projection/serialization helpers shared by the read + write handlers. Pure
// shaping over an already-parsed reader doc (frontmatter + body) and the `ArtifactTarget` ⟷ docId mapping;
// no HTTP, no fs. The reader/WriteService own the bytes and the invariants — these functions only project
// the on-disk shape into the transport `DocModel` the editor consumes, and translate between the docId
// string the web sends and FLOW's `ArtifactTarget`.
import { type DocModel } from "@agentry/workbench-shared";
import { computeVersion } from "@agentry/flow/domain/version";
import type { WorkReader } from "../application/work-reader.js";
import type { ArtifactTarget } from "../persistence/flow-writer.js";

// Re-read one doc as a fresh DocModel after a write (so the ws push + the artifact response carry the
// re-stamped version + current lock). Returns undefined when the run or doc no longer resolves.
export function reloadDoc(
  reader: WorkReader,
  runId: string,
  target: ArtifactTarget,
): DocModel | undefined {
  const read = reader.read(runId);
  if (!read) return undefined;
  const found = read.docs.find((d) => d.id === docIdOf(target));
  return found ? toDocModel(found) : undefined;
}

// The doc id for an artifact target — the SAME keys the reader's `docs` use (buildGraph node ids): a
// run-root artifact is its `kind` ("spec"/"plan"); a task is `task-<no>`.
export function docIdOf(target: ArtifactTarget): string {
  return "kind" in target ? target.kind : `task-${target.taskNo}`;
}

// Project a reader doc (frontmatter+body) into the transport DocModel. The `version` is the optimistic-
// concurrency token the client echoes back as `baseVersion` — it MUST equal what `WriteService` checks
// against on save, which is FLOW's `computeVersion(body, frontmatter-sans-version)` (ADR-006), NOT the
// frontmatter's stamped `version` field (those can drift on a hand-edited file — a stale stamp would
// false-reject every save). So we recompute it here over the same (body, frontmatter-sans-version)
// inputs the write boundary uses, reusing FLOW's shared hash (ADR-005). The lock is derived from FLOW's
// `status:in-progress` + `lockedBy` — null when the doc is free.
export function toDocModel(doc: { frontmatter: Record<string, unknown>; body: string }): DocModel {
  const { version: _stamped, ...sansVersion } = doc.frontmatter;
  return {
    frontmatter: doc.frontmatter,
    body: doc.body,
    version: computeVersion(doc.body, sansVersion),
    lock: lockOf(doc.frontmatter),
  };
}

// Derive the edit lock the editor shows: a task whose `status === "in-progress"` is locked by `lockedBy`
// (or its assignee). Run-root artifacts carry no task lifecycle → never locked. Mirrors the WriteService
// lock check (ADR-006), read-only here.
export function lockOf(frontmatter: Record<string, unknown>): DocModel["lock"] {
  if (frontmatter.status !== "in-progress") return null;
  const by = frontmatter.lockedBy;
  const assignee = frontmatter.assignee;
  const holder =
    typeof by === "string" && by.length > 0
      ? by
      : typeof assignee === "string" && assignee.length > 0
        ? assignee
        : "an agent";
  const acquiredAt = typeof frontmatter.updatedAt === "string" ? frontmatter.updatedAt : "";
  return { by: holder, acquiredAt };
}

// Map the `docId` STRING the web client sends to the WriteService's `ArtifactTarget`, the inverse of
// `docIdOf`. The docId is the SAME id GET /doc/:docId returns (mirrors buildGraph's node ids):
//   "spec"        → { kind: "spec" }
//   "plan"        → { kind: "plan" }
//   "task-<NNN>"  → { taskNo: "<NNN>" }
//   "adr-*"       → "read_only"  (ADRs are decision records — read-only in V1, the route rejects writes)
//   anything else → null          (unknown target → 400)
// The client is never trusted (ADR-006): an empty/missing/non-string target is `null`, and a `task-`
// id with no number is `null` (not a write target).
export function targetFromDocId(raw: unknown): ArtifactTarget | "read_only" | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw === "spec" || raw === "plan") return { kind: raw };
  if (raw.startsWith("adr-")) return "read_only";
  if (raw.startsWith("task-")) {
    const taskNo = raw.slice("task-".length);
    return taskNo.length > 0 ? { taskNo } : null;
  }
  return null;
}

// Derive the task number for a takeover from the request body — accept the `docId` form
// (`target: "task-<NNN>"`, the shape the web sends) or a legacy `{ taskNo }`. Only TASK docs are
// take-overable (they alone carry status/lockedBy); a non-task `target` (spec/plan/adr-*) yields null.
export function taskNoFromTakeover(body: Record<string, unknown>): string | null {
  const target = body.target;
  if (typeof target === "string" && target.startsWith("task-")) {
    const taskNo = target.slice("task-".length);
    return taskNo.length > 0 ? taskNo : null;
  }
  const taskNo = body.taskNo;
  return typeof taskNo === "string" && taskNo.length > 0 ? taskNo : null;
}
