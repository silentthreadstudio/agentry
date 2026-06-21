---
title: markdown-serializer + golden round-trip corpus (the tripwire, ADR-004)
status: done
lockedBy: implementer
assignee: implementer
version: 4129f23730302e5b
---

---
phase: 3
kind: feature
status: todo
deps: [1]
parallel_safe_with: [15]
---

## Goal
Build the ONE markdown↔Tiptap serializer module (`mdToTiptap` / `tiptapToMd`) plus the golden round-trip corpus that asserts `tiptapToMd(mdToTiptap(x)) === normalize(x)` over real `.agentry/` artifacts. This is the tripwire against silent artifact corruption — built FIRST in the phase (plan §6, ADR-004).

## Contract
- **owns:** `packages/workbench/web/src/routes/work/live/doc/markdown-serializer.ts`, `packages/workbench/web/src/test/**` (the golden round-trip corpus + fixtures: a spec, a plan, an ADR with Context/Decision/Alternatives/Consequences cards, a task with a deps list + code fence)
- **exposes:** `mdToTiptap(body) → ProseMirrorDoc` and `tiptapToMd(doc) → body`, configured to the fixed artifact schema (headings, paragraphs, lists, code blocks/inline code, blockquotes, bold/italic, links, and the custom comment mark which serializes to NOTHING in markdown); the `normalize(body)` canonical form applied identically on read and write. Pin: the serializer API + the `normalize` function (task 16's DocDrawer + task 18's CommentMark + the write path all use them).
- **must NOT touch:** `CommentMark.ts` (task 18 owns the mark definition — the serializer only knows to strip it), `DocDrawer.tsx` (task 16), `server/**`.

## Approach
- Inherit ADR-004 verbatim: **frontmatter is split off before the editor** (same `FRONTMATTER` regex FLOW uses); only `body` round-trips; one module owns both directions; built on a known md library (`markdown-it` in, a ProseMirror→markdown serializer out). The comment mark serializes to nothing (UI-only; persisted to `.review/`).
- **Normalization is load-bearing** (ADR-006 link): defined once, applied to both the on-disk file on first read AND the save output, so a no-op edit is byte-stable → same `computeVersion` → no false optimistic-concurrency rejection. Build this carefully.
- The golden corpus is the guard: a failing golden test **blocks the build**. Cover the real artifact constructs (ADR decision cards, deps lists, code fences) — a serializer gap silently corrupts (risk §2).
- Source-mode bypasses the serializer (task 16 owns SourceMode) — this module is the rich path only.

## Acceptance
- `tiptapToMd(mdToTiptap(x)) === normalize(x)` passes for every corpus artifact (idempotent up to normalization); a deliberately-introduced lossy mapping fails a golden test.
- `normalize` is byte-stable on a no-op (same input → same output), proving the AC6 link.
- Advances AC4/AC5/AC6 (the round-trip foundation). Verifier runs the golden suite.
