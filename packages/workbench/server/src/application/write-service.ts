// WriteService — the SINGLE server-side write boundary (ADR-006). Every write the Workbench performs
// passes through here, and the two clobber-safety invariants are enforced HERE, server-side, with the
// client never trusted:
//   1. Lock     — an artifact whose task `status === "in-progress"` is locked by its assignee; an edit
//                 is rejected with the `lockedBy` value. The check re-reads the frontmatter from disk
//                 AT WRITE TIME (not at open time), so a concurrent agent `task_status(in-progress)`
//                 between page-load and save is caught.
//   2. Optimistic concurrency — the client echoes back the opaque `baseVersion` it was handed on open;
//                 the service recomputes the CURRENT on-disk version (FLOW's `computeVersion`) and
//                 rejects when it differs (someone wrote in between). The client never computes a
//                 version — FLOW owns the hash; the client only carries the token.
// `takeOver` is the explicit server-performed lock transition (the human claiming the edit); only
// after it succeeds is a write allowed. Comments are allowed even when locked — the lock gates *edits*,
// not *annotations* (VISION §5).
//
// PURE application (ADR-001): it depends only on the `FlowWriterPort` (the write adapter) — no
// `node:http`/`ws`/`node:fs` type crosses it — so the whole boundary is unit-testable against a fake
// writer with no disk and no websocket. The route layer (task 17) maps these typed outcomes to HTTP;
// this service never builds an HTTP envelope and never throws for an expected rejection (a stale save
// is a typed `stale` outcome, not an exception). It reuses FLOW's shapes (ADR-005/007) — never
// redeclaring `ReviewComment`/`ReviewAnchor`/`ReviewDecision`/`FlowTaskStatus`.
import { FlowTaskStatus } from "@agentry/flow/domain/status";
import type { ReviewAnchor, ReviewComment, ReviewDecision } from "@agentry/flow/domain/review";
import type { ArtifactTarget, CurrentArtifact, FlowWriterPort } from "../persistence/flow-writer.js";

// ── Request shapes (PINNED — task 17's POST routes construct these) ─────────────────────────────────

// Append a review comment to a gate's sidecar. Allowed even when the annotated doc is locked.
export interface AddCommentRequest {
  run: string;
  gate: string;
  anchor: ReviewAnchor; // the 3-way anchor (originalText/headingAnchor/startLine) — FLOW's shape
  decision: ReviewDecision; // approve | changes | question
  body: string;
  // Reply lane: when set, this nests under `replyTo` and carries `origin:"human"` (a human follow-up in
  // a thread). A top-level annotation leaves both unset (absent origin ⇒ human, FLOW's back-compat rule).
  replyTo?: string;
  origin?: "human" | "agent";
}

// Write an artifact body. `target` addresses a run-root artifact (`kind`) or a task file (`taskNo`).
// `baseVersion` is the opaque FLOW version the client was handed on open (its freshness proof);
// `newBody` is the ALREADY-NORMALIZED body (task 14 ran `normalize` in the route/web path).
export interface WriteArtifactRequest {
  run: string;
  target: ArtifactTarget;
  baseVersion: string;
  newBody: string;
}

// Claim the edit: the explicit server-performed lock transition on a task (flip `lockedBy`/`status`
// off `in-progress`), after which a write is allowed. `by` is the human claiming it.
export interface TakeOverRequest {
  run: string;
  taskNo: string;
  by: string;
}

// ── Outcomes (typed discriminated unions the route maps to ok()/err() — mirrors ReviewService) ──────

// A write either succeeds with the freshly-stamped `version`, or is rejected for one of the two
// invariants, or the artifact is gone. The route turns each into the right HTTP status/envelope.
export type WriteArtifactOutcome =
  | { ok: true; version: string } // written; the new version to push to the client
  | { ok: false; reason: "locked"; lockedBy: string } // status===in-progress (AC4)
  | { ok: false; reason: "stale"; currentVersion: string } // baseVersion ≠ on-disk (AC6)
  | { ok: false; reason: "not-found" }; // the artifact no longer exists

export type TakeOverOutcome =
  | { ok: true } // the lock was released; a write is now allowed
  | { ok: false; reason: "not-found" }; // no such task file to take over

export class WriteService {
  constructor(private readonly writer: FlowWriterPort) {}

  // Append a comment with the 3-way anchor to the gate's sidecar — ALWAYS allowed, lock or not
  // (VISION §5: you can always annotate). The id is minted here (the caller gets a handle back) and
  // a fresh comment is open (`resolved:false`), mirroring FLOW's ReviewService.comment.
  addComment(req: AddCommentRequest): { id: string } {
    const id = mintCommentId();
    const comment: ReviewComment = {
      id,
      anchor: req.anchor,
      decision: req.decision,
      body: req.body,
      resolved: false,
      // Only stamp the reply fields when present, so a top-level comment's on-disk shape is byte-identical
      // to before (no `origin`/`replyTo` keys) — keeps old sidecars and these writes indistinguishable.
      ...(req.replyTo !== undefined ? { replyTo: req.replyTo } : {}),
      ...(req.origin !== undefined ? { origin: req.origin } : {}),
    };
    this.writer.appendComment(req.run, req.gate, comment);
    return { id };
  }

  // Resolve a comment by id in the gate sidecar — the rail's Resolve action, persisted to disk so it
  // survives reload (VISION §6). `ok:false` means no comment carried that id (the route → 404). Always
  // allowed (resolving an annotation is not an edit, so the lock gate does not apply — VISION §5).
  resolveComment(req: { run: string; gate: string; commentId: string }): { ok: boolean } {
    return { ok: this.writer.resolveComment(req.run, req.gate, req.commentId) };
  }

  // The guarded artifact write — the clobber-safety core (AC4/AC6). Re-reads disk at write time, then:
  //   1. not-found  → the artifact is gone (a concurrent delete).
  //   2. locked     → the task is `in-progress`; reject with `lockedBy` (the UI shows who holds it).
  //   3. stale      → the recomputed current version ≠ the client's `baseVersion`; reject (someone
  //                   wrote in between) — optimistic concurrency.
  //   4. else       → recombine the UNTOUCHED frontmatter + the normalized body, re-stamp the version,
  //                   and return the new version to push to the client.
  writeArtifact(req: WriteArtifactRequest): WriteArtifactOutcome {
    const current = this.writer.readArtifact(req.run, req.target);
    if (current === undefined) return { ok: false, reason: "not-found" };

    const lock = this.lockOf(current);
    if (lock !== undefined) return { ok: false, reason: "locked", lockedBy: lock };

    if (current.version !== req.baseVersion) {
      return { ok: false, reason: "stale", currentVersion: current.version };
    }

    const version = this.writer.writeArtifact(
      req.run,
      req.target,
      current.frontmatter, // untouched frontmatter — only the body is the edit (ADR-006)
      req.newBody,
    );
    return { ok: true, version };
  }

  // Take over: the explicit lock transition the SERVER performs (the human claims the edit). Re-reads
  // the task, then writes back its frontmatter with the lock released (`status` → `in-review`, the
  // not-in-progress state a human edit moves to; `lockedBy` → the claimer), re-stamping the version.
  // After this, `writeArtifact` against the same task passes the lock gate. A no-op body write keeps
  // the body byte-identical so the take-over does not alter the prose (the lock flip is frontmatter).
  takeOver(req: TakeOverRequest): TakeOverOutcome {
    const target: ArtifactTarget = { taskNo: req.taskNo };
    const current = this.writer.readArtifact(req.run, target);
    if (current === undefined) return { ok: false, reason: "not-found" };

    const frontmatter: Record<string, unknown> = {
      ...current.frontmatter,
      status: "in-review", // off `in-progress` → the lock gate now passes
      lockedBy: req.by, // the human now holds the edit
    };
    this.writer.writeArtifact(req.run, target, frontmatter, current.body);
    return { ok: true };
  }

  // Set a task's lifecycle status (the human override — cleanup note 3: agents sometimes don't move a
  // task to done). Re-reads the task, writes its frontmatter with the new `status`, re-stamps the version.
  // When the status leaves `in-progress`, the agent lock is released (`lockedBy` dropped) so the doc is
  // free; setting it TO `in-progress` keeps any existing holder. `not-found` for an absent task file.
  setStatus(req: { run: string; taskNo: string; status: FlowTaskStatus }): TakeOverOutcome {
    const target: ArtifactTarget = { taskNo: req.taskNo };
    const current = this.writer.readArtifact(req.run, target);
    if (current === undefined) return { ok: false, reason: "not-found" };

    const frontmatter: Record<string, unknown> = { ...current.frontmatter, status: req.status };
    if (req.status !== "in-progress") delete frontmatter.lockedBy;
    this.writer.writeArtifact(req.run, target, frontmatter, current.body);
    return { ok: true };
  }

  // The lock check (ADR-006): a task is locked when its on-disk `status === "in-progress"`, and the
  // holder is `lockedBy` (falling back to the assignee, then a generic label so the UI always has a
  // name). Run-root artifacts (spec/plan) carry no task lifecycle, so they are never lock-gated.
  // Returns the holder when locked, else undefined.
  private lockOf(current: CurrentArtifact): string | undefined {
    const parsed = FlowTaskStatus.safeParse(current.frontmatter.status);
    if (!parsed.success || parsed.data !== "in-progress") return undefined;
    const lockedBy = current.frontmatter.lockedBy;
    if (typeof lockedBy === "string" && lockedBy.length > 0) return lockedBy;
    const assignee = current.frontmatter.assignee;
    if (typeof assignee === "string" && assignee.length > 0) return assignee;
    return "an agent";
  }
}

// A short, collision-resistant comment id (base36) — the SAME style FLOW's ReviewService mints, so a
// Workbench-written comment is indistinguishable from a FLOW-written one in the shared sidecar.
function mintCommentId(): string {
  return `c-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}
