// ReviewComment — the review-sidecar shape (spec AC10). Pure zod, no I/O. Consumed by T04's review
// service (`review_comment`/`review_resolve`/`review_list`), which persists these to
// `.agentry/work/<run>/.review/<gate>.annotations.json`.
//
// The 3-way anchor (spec §3.1 / AC10) lets a comment survive edits to the document it annotates:
// `originalText` (the exact snippet quoted), `headingAnchor` (the nearest section), and `startLine`
// (the line it was made at) together re-locate the comment even when one of the three has drifted.
import { z } from "zod";

// The conductor's decision on the commented span — the review verdict vocabulary.
export const ReviewDecision = z.enum(["approve", "changes", "question"]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

// The 3-way anchor that re-locates a comment after the document changes.
export const ReviewAnchor = z.object({
  originalText: z.string(), // the exact snippet the comment was made against
  headingAnchor: z.string(), // the nearest section heading
  startLine: z.number(), // the line the comment was made at
});
export type ReviewAnchor = z.infer<typeof ReviewAnchor>;

// Who authored an entry on the `.review/` bus (ADR-002). The bus carries TWO message kinds on one
// directory: the human's review comment (the default) and the agent's `channel_reply`. The marker is
// what lets the bridge skip the agent's own replies (no echo loop) and lets open-gate read-models
// keep the "waiting on you" list human-only. ABSENT ⇒ "human" — every pre-Phase-2 sidecar (no field)
// parses as a human comment, so the addition is back-compatible.
export const ReviewOrigin = z.enum(["human", "agent"]);
export type ReviewOrigin = z.infer<typeof ReviewOrigin>;

export const ReviewComment = z.object({
  id: z.string(),
  anchor: ReviewAnchor,
  decision: ReviewDecision,
  body: z.string(),
  resolved: z.boolean(), // distinguishes open from resolved comments (AC10: review_resolve marks one)
  // ── Phase 2 reply lane (ADR-002) — both optional + additive so old sidecars still parse ──────────
  origin: ReviewOrigin.optional(), // absent ⇒ human; "agent" marks a channel_reply (Phase 2b's rail)
  replyTo: z.string().optional(), // the human comment id this reply answers (threading; agent only)
});
export type ReviewComment = z.infer<typeof ReviewComment>;

// Whether a comment is human-authored. Origin is OPTIONAL on the shape (back-compat): an absent origin
// is treated as human, so a pre-Phase-2 sidecar (no field) and an explicit `origin:"human"` are equal.
// The bridge + open-gate read-models route on THIS, not on a bare `origin === "human"` check.
export function isHumanComment(comment: ReviewComment): boolean {
  return comment.origin !== "agent";
}
