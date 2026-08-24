// review-types — the FLOW review shapes the comment loop needs (`ReviewComment` / `ReviewAnchor` /
// `ReviewDecision`), reached through the read-model WITHOUT redefining them and WITHOUT importing
// `@agentry/flow` directly (the web tsconfig has no FLOW `paths` shim — that's the server/shared side).
//
// The shared barrel (`@agentry/workbench-shared`) re-exports `GateItem`, whose `comments` field is
// `ReviewComment[]` — FLOW's closed shape. We project the three sub-shapes off that one public type, so a
// FLOW review-schema change still ripples here as a compile error (the desync guard) rather than a silent
// drift, and this task adds no new cross-package import. When the shared barrel re-exports the review
// types directly, swap these aliases for that import and delete this file.
import type { GateItem } from "@agentry/workbench-shared";

/** FLOW's `ReviewComment` (the gate-sidecar entry), reached via `GateItem.comments`. */
export type ReviewComment = GateItem["comments"][number];

/** FLOW's 3-way `ReviewAnchor` (originalText / headingAnchor / startLine). */
export type ReviewAnchor = ReviewComment["anchor"];

/** FLOW's `ReviewDecision` (`approve | changes | question`). */
export type ReviewDecision = ReviewComment["decision"];
