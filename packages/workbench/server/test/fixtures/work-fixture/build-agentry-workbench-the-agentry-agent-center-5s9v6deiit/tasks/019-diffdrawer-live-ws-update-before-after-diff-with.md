---
title: "DiffDrawer: live ws update + before/after diff with
  Accept/Reject/Iterate (AC7)"
status: done
lockedBy: implementer
assignee: implementer
version: c70f043babf950f2
---

---
phase: 3
kind: feature
status: todo
deps: [16, 17]
parallel_safe_with: [18]
---

## Goal
Build the `DiffDrawer`: when an agent change live-updates a watched doc over the websocket (no reload), and on a comment reply, render the before/after diff with Accept/Reject/Iterate. Closes the diff half of AC7.

## Contract
- **owns:** `packages/workbench/web/src/routes/work/live/doc/DiffDrawer.tsx`
- **exposes:** the diff UI mounted in the doc drawer (via task 16's pinned drawer slot) — consumes `doc-updated`/`diff-ready` `WsMessage`s (task 9/17 push them) and renders the before/after, with Accept/Reject/Iterate actions wired to the write/comment endpoints (task 17).
- **must NOT touch:** `DocDrawer.tsx`/`LockBar`/`SourceMode` (task 16 — mount in its slot, don't edit), `CommentMark`/`CommentRail`/`SelectionBubble` (task 18), `markdown-serializer.ts` (task 14), `server/**`.

## Approach
- Inherit the live loop (plan §3): agent writes a file → watcher fires → `event-store`/`work-reader` re-projects → `ws` pushes a `WsMessage` keyed to the run → the doc updates with **no reload**. This task renders the before/after when that lands, plus the comment-reply diff.
- The diff is markdown-body level (use task 14's normalized `body` for both sides so the diff is clean, not serializer-noise). Accept writes via `/artifact` (task 17), Reject discards, Iterate re-opens the editor / posts a follow-up comment.
- Design see-it loop against `prototype-document.html` (the diff treatment).
- Consume the **pinned** `WsMessage` discriminants from task 1's `shared` types (`doc-updated`, `diff-ready`).

## Acceptance
- An agent edit to a watched file live-updates the open doc over ws with **no reload** (AC7); a before/after diff renders with Accept/Reject/Iterate.
- Accept writes via `/artifact` (bumping version); Reject/Iterate behave per spec.
- Closes the diff half of AC7. Designer confirms against `prototype-document.html`. Verifier triggers a live agent edit and exercises the diff actions.
