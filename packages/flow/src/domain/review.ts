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

export const ReviewComment = z.object({
  id: z.string(),
  anchor: ReviewAnchor,
  decision: ReviewDecision,
  body: z.string(),
  resolved: z.boolean(), // distinguishes open from resolved comments (AC10: review_resolve marks one)
});
export type ReviewComment = z.infer<typeof ReviewComment>;
