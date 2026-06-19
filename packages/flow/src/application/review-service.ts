// ReviewService — the application layer over the `ReviewStore` port (T01), implementing the review
// sidecar's three operations (spec AC10). It owns the field semantics the thin tool adapters don't:
// minting a comment id, defaulting `resolved:false` on append, and flipping one comment's `resolved`
// on resolve. It holds NO state of its own — the `ReviewStore` (a per-gate annotations file) is the
// only state holder (AC6); every call threads an explicit `run` (ADR-005 NO branch).
//
// The service emits typed outcomes the adapter switches on (mirroring @agentry/memory's
// MemoryService): it never builds an error envelope and never throws for an expected failure
// (a resolve against an unknown id is `not-found`, not an exception). Envelope prose lives in
// tools/errors.ts at the adapter boundary.
import type { ReviewStore } from "../domain/ports.js";
import type { ReviewAnchor, ReviewComment, ReviewDecision } from "../domain/review.js";

// The fields a caller supplies to append a comment — everything on `ReviewComment` except the
// service-owned `id` and `resolved` (minted/defaulted here, not caller-supplied).
export interface CommentInput {
  run: string;
  gate: string;
  anchor: ReviewAnchor;
  decision: ReviewDecision;
  body: string;
}

// Resolve outcome — a typed discriminated union the adapter maps to ok()/err(). `not-found` carries
// the offending id so the envelope can name it; the service never builds the envelope itself.
export type ResolveOutcome =
  | { ok: true; id: string }
  | { ok: false; reason: "not-found"; id: string };

// A short, collision-resistant comment id (base36) — enough entropy to disambiguate comments on one
// gate without a heavyweight dependency (review comments are scratch annotations, not addresses).
// Mirrors the run-id `shortId` style in domain/ids.ts.
function mintCommentId(): string {
  return `c-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

export class ReviewService {
  constructor(private readonly reviews: ReviewStore) {}

  // Append a comment with the 3-way anchor to the gate's sidecar. A fresh comment is always open
  // (`resolved:false`); the id is minted here so the caller gets back a handle to resolve it later.
  comment(input: CommentInput): { id: string } {
    const id = mintCommentId();
    const comment: ReviewComment = {
      id,
      anchor: input.anchor,
      decision: input.decision,
      body: input.body,
      resolved: false,
    };
    const existing = this.reviews.read(input.run, input.gate);
    this.reviews.write(input.run, input.gate, [...existing, comment]);
    return { id };
  }

  // Mark one comment resolved so it is distinguishable from open ones (AC10). Idempotent: resolving an
  // already-resolved comment succeeds (the post-state is the same). An unknown id is `not-found`.
  resolve(run: string, gate: string, id: string): ResolveOutcome {
    const comments = this.reviews.read(run, gate);
    const target = comments.find((c) => c.id === id);
    if (target === undefined) return { ok: false, reason: "not-found", id };
    const next = comments.map((c) => (c.id === id ? { ...c, resolved: true } : c));
    this.reviews.write(run, gate, next);
    return { ok: true, id };
  }

  // The gate's comments — what the conductor reads AT the gate to see open vs. resolved annotations.
  list(run: string, gate: string): { comments: ReviewComment[] } {
    return { comments: this.reviews.read(run, gate) };
  }
}
