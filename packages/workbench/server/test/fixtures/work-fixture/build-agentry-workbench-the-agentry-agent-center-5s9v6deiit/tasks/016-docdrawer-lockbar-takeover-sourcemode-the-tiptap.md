---
title: DocDrawer + LockBar/TakeOver + SourceMode (the Tiptap doc over the dimmed
  graph, AC4)
status: done
lockedBy: implementer
assignee: implementer
version: ab0a0c6d6b02a12d
---

---
phase: 3
kind: feature
status: todo
deps: [14, 12]
parallel_safe_with: [15]
---

## Goal
Build the document drawer: `DocDrawer` (the Tiptap editor over the dimmed graph, opened from a node), `LockBar`/`TakeOver` (lock-aware UI — in-progress read-only + lockedBy; todo/done editable; Take over flips the lock), and `SourceMode` (the CodeMirror raw-markdown escape hatch). Closes AC4 on the web side.

## Contract
- **owns:** `packages/workbench/web/src/routes/work/live/doc/DocDrawer.tsx`, `packages/workbench/web/src/routes/work/live/doc/LockBar.tsx`, `packages/workbench/web/src/routes/work/live/doc/TakeOver.tsx`, `packages/workbench/web/src/routes/work/live/doc/SourceMode.tsx`
- **exposes:** the `DocDrawer` opened from a `DocNode` (task 13) — fills the doc slot over the Panorama; the lock-aware header (status pill / version / lockedBy as read-only typed frontmatter fields, ADR-004); the source-mode toggle. Pin: the drawer-open contract `DocNode` triggers + the doc-fetch endpoint it reads.
- **must NOT touch:** `markdown-serializer.ts`/`normalize` (task 14 — consume it), `CommentMark.ts`/`CommentRail.tsx`/`SelectionBubble.tsx` (task 18 — comment UI plugs in later), `DiffDrawer.tsx` (task 19), `server/**`.

## Approach
- Inherit ADR-004: frontmatter is split + rendered as **read-only/typed fields** in the header (status, version, lockedBy never user-editable); only `body` enters Tiptap via task 14's `mdToTiptap`; save re-serializes via `tiptapToMd` + `normalize`. SourceMode edits raw `body` as plain text (CodeMirror), bypassing the serializer (the safety valve).
- Inherit ADR-006 on the UI side: an `in-progress` doc renders **read-only** showing `lockedBy`; `todo`/`done` are editable; **Take over** calls the takeover endpoint (task 17) and flips the lock. The client echoes the opaque `baseVersion` it was given on save — never computes a version.
- Design is a constraint: match `design/prototype-document.html` (the doc-over-dimmed-graph treatment) — designer see-it loop, no UI ships unseen.
- Add Tiptap + CodeMirror as web deps (Phase-3 deps, bundle into Vite assets, ADR-003).
- Save POSTs to task 17's `/artifact` endpoint with `{ baseVersion, newBody }`; a stale-version rejection surfaces in the UI (AC6 feedback).

## Acceptance
- Clicking a node opens it as a Tiptap doc; an `in-progress` artifact is read-only showing `lockedBy`; a `todo`/`done` one is editable; **Take over** flips the lock (AC4).
- SourceMode toggles to raw markdown and back; a no-op edit save is byte-stable (normalize, no false rejection).
- Designer confirms the rendered drawer against `prototype-document.html`. Closes the web side of AC4. Verifier opens a locked + an unlocked node.
