---
title: CommentMark + CommentRail + SelectionBubble (span-comment →
  3-way-anchored sidecar, AC5)
status: done
lockedBy: implementer
assignee: implementer
version: 3b6cbb94c392106d
---

---
phase: 3
kind: feature
status: todo
deps: [16, 17]
parallel_safe_with: [19]
---

## Goal
Build the comment loop: `CommentMark` (the ProseMirror comment mark whose anchor tracks edits), `SelectionBubble` (select a span → comment), and `CommentRail` (the rail of comments). Selecting a span + commenting writes a 3-way-anchored entry to `.review/<gate>.json`, shows in the rail, and badges the node. Closes AC5.

## Contract
- **owns:** `packages/workbench/web/src/routes/work/live/doc/CommentMark.ts`, `packages/workbench/web/src/routes/work/live/doc/CommentRail.tsx`, `packages/workbench/web/src/routes/work/live/doc/SelectionBubble.tsx`
- **exposes:** the `CommentMark` (a Tiptap/ProseMirror mark that serializes to NOTHING in markdown — task 14's serializer already strips it; this task defines the mark itself), the selection-bubble comment-compose UI, and the rail. Builds the 3-way anchor (`originalText` = selected span, `headingAnchor` = nearest `##`, `startLine` = body line) and POSTs it to task 17's `/comment` endpoint. Also surfaces the node-badge signal (count of open comments) consumed by task 13's `DocNode`.
- **must NOT touch:** `markdown-serializer.ts` (task 14 — it already strips the mark), `DocDrawer.tsx`/`LockBar`/`SourceMode` (task 16 — the mark + rail mount *inside* the drawer via its pinned slots), `DiffDrawer.tsx` (task 19), `server/**`.

## Approach
- Inherit ADR-004 (the comment mark is UI-only, persisted to `.review/` not markdown) + the data contract (plan §3): `.review/<gate>.annotations.json` = `ReviewComment[]`, each `{ id, anchor:{originalText,headingAnchor,startLine}, decision, body, resolved }` — use `@agentry/flow`'s `ReviewComment`/`ReviewAnchor` shapes (ADR-005, via the read-model). Comments are allowed even when the doc is locked (ADR-006).
- The mark's anchor **tracks edits** (ProseMirror mapping) so an agent's later edit doesn't orphan the comment; the 3-way anchor is the re-attach fallback the server stores.
- Design see-it loop against `prototype-document.html` (the comment/rail treatment).
- The node-badge: expose an open-comment count keyed by run+doc that task 13's `DocNode` reads (coordinate the pinned signal; this task produces it, DocNode consumes — within Phase 2/3, DocNode merged in P2, so expose via the shared store/api, not by editing DocNode).

## Acceptance
- Selecting a span + commenting writes a 3-way-anchored `ReviewComment` to `.review/<gate>.annotations.json` (via `/comment`), shows it in the rail, and badges the node (AC5).
- The mark serializes to nothing in markdown (a commented body round-trips unchanged through task 14's serializer).
- Designer confirms against `prototype-document.html`. Verifier comments on a span and inspects the sidecar JSON.
