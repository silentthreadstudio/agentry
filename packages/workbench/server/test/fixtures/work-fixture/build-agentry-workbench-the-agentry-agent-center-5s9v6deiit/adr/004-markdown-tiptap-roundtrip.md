---
id: ADR-004
title: Markdown stays truth — frontmatter-split, a single serializer module, golden round-trip tests, source-mode escape hatch
status: accepted
date: 2026-06-19
deciders: architect
---

# ADR-004 — The markdown ↔ Tiptap round-trip: markdown stays truth

## Context

A node opens as a **Tiptap (ProseMirror) document** of the same `.agentry/` markdown; an edit saved by the human
is what the agent reads back next turn (VISION §5, doc 10 §3b). But **markdown is truth** — the file on disk is
what FLOW hashes and what the agent parses. Tiptap's document model is HTML/ProseMirror-JSON, not markdown, so
every open is markdown→editor and every save is editor→markdown. Two hazards: (1) a lossy round-trip silently
corrupts the artifact (a `**bold**` that comes back `__bold__`, a collapsed list, a mangled code fence) — and the
*version hash changes on a no-op edit*, which would wrongly trip optimistic concurrency (ADR-006); (2) the FLOW
frontmatter (`status`/`version`/`lockedBy`/`deps`) is **structured fields**, not prose — round-tripping it through
the rich editor would let a user accidentally edit the version hash or reformat YAML (VISION §5: "frontmatter is
parsed out and edited as fields, never round-tripped as prose").

## Decision

**Frontmatter is split off before the editor ever sees the body; the body round-trips through one serializer
module guarded by golden tests; a raw source-mode is the escape hatch.**

- **Frontmatter split.** On open, the doc model is `{ frontmatter: Record, body: string }` parsed with the **same
  `FRONTMATTER` regex FLOW's `task-file-store` uses** (`/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/`). Only `body` enters
  Tiptap. Frontmatter renders as **read-only/typed fields** in the doc header (status pill, version, lockedBy,
  deps) — `version`/`lockedBy` are never user-editable (FLOW owns them); editable fields (where any) write back
  through the FLOW write path. On save, the server **recombines** the (untouched) frontmatter with the
  re-serialized body and writes via the FLOW write contract, which re-stamps `version`.
- **One serializer module, both directions, in the web layer.** A single `markdown-serializer` module owns
  `mdToTiptap(body) → ProseMirrorDoc` and `tiptapToMd(doc) → body`, built on a known markdown library
  (`markdown-it` parse in, a ProseMirror→markdown serializer out, both configured to the small, fixed schema the
  artifacts use: headings, paragraphs, lists, code blocks/inline code, blockquotes, bold/italic, links, and the
  custom **comment mark** which serializes to *nothing* in markdown — it's a UI-only annotation, persisted instead
  to the `.review/` sidecar). This is the **one place** the mapping lives; nothing else parses or emits markdown.
- **Golden round-trip tests are the guard (VISION §5).** A corpus of real `.agentry/` artifacts (a spec, a plan,
  an ADR with the Context/Decision/Alternatives/Consequences cards, a task with a deps list and a code fence) is
  asserted **`tiptapToMd(mdToTiptap(x)) === normalize(x)`** — idempotent up to a defined normalization (the
  serializer's canonical form). A failing golden test blocks the build: it is the tripwire against silent artifact
  corruption. Normalization is defined once and applied to *both* the on-disk file (on first read) and the save
  output, so a no-op editor session produces a byte-identical body and therefore an identical version hash (no
  false optimistic-concurrency rejection).
- **Source-mode escape hatch.** A CodeMirror raw-markdown toggle (VISION §5) edits `body` as plain text, bypassing
  the serializer entirely — the power-edit path and the safety valve for any construct the rich serializer doesn't
  model. Saving from source mode writes the raw text directly (still frontmatter-recombined, still
  version-stamped). The ADR **decision cards** are a *render-time* treatment of an ADR's headings — they do not
  change the underlying markdown (an ADR is still plain markdown on disk).

## Alternatives

1. **Store the artifact as ProseMirror JSON / HTML (editor model = truth).** Rejected: breaks files-are-truth —
   the agent and FLOW parse markdown, not ProseMirror JSON; it would fork the on-disk contract.
2. **Round-trip frontmatter through the editor as prose.** Rejected: lets a user corrupt the version hash / YAML;
   contradicts VISION §5. Split it out and type it.
3. **A lossy "good enough" serializer, no golden tests.** Rejected: a silent corruption of a spec/plan is
   exactly the failure that destroys trust in "your edit is what the agent reads"; the golden corpus is cheap
   insurance and VISION names it explicitly.
4. **Tiptap's official markdown extension only, no custom serializer module.** Rejected as the *sole* strategy:
   it's a fine implementation choice *inside* the serializer module, but the boundary (one module, golden-tested,
   comment-mark stripped, frontmatter split) is what this ADR fixes — the library underneath is swappable behind it.

## Consequences

- **Good:** markdown stays the single source of truth; a no-op edit is byte-stable so optimistic concurrency
  doesn't misfire; frontmatter (and especially `version`) is unforgeable from the editor.
- **Good:** the round-trip risk is contained to one module with an executable guard; a serializer regression fails
  a test, never ships a corrupted artifact.
- **Cost:** the rich editor supports only the fixed artifact schema; anything exotic must use source-mode. Aligned
  with the artifacts' actual content (they are structured markdown, not arbitrary documents).
- **Cost:** maintaining the golden corpus as artifact conventions evolve — a small, well-scoped test-maintenance
  burden, and the right place to feel a convention change.
