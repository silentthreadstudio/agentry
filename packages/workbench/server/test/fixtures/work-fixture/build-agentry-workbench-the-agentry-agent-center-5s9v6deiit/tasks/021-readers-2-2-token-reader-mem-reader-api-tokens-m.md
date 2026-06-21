---
title: "readers (2/2): token-reader + mem-reader + /api/{tokens,memory} endpoints"
status: done
lockedBy: implementer
assignee: implementer
version: 60cc56a3d4ad664a
---

---
phase: 4
kind: feature
status: todo
deps: [6, 9]
parallel_safe_with: [20]
---

## Goal
Build the external-source readers: `token-reader` (Claude Code session transcripts → `TokenSeries` per run/agent/day) and `mem-reader` (READ-ONLY over the `mem` file-store facts/episodes `.md` → browse/search). Expose via `/api/tokens` and `/api/memory`. The second half of the reader seam (plan §6).

## Contract
- **owns:** `packages/workbench/server/src/application/token-reader.ts`, `packages/workbench/server/src/persistence/mem-reader.ts`, `packages/workbench/server/src/persistence/transcript-reader.ts`, and the GET handlers `/api/tokens`, `/api/memory` appended to `transport/routes.ts`
- **exposes:** `TokenReader` → `TokenSeries` (the Tokens page data); `MemReader` (read-only) → memory browse/search over `<root>/facts/*.md` + `<root>/episodes/*.md` (global `~/.agentry/memory` + project `.agentry/memory`). Pin the endpoint paths + `TokenSeries` shape (task 1). Consumed by task 24 (Tokens) + task 25 (Memory).
- **must NOT touch:** `event-store.ts`/`gate-inbox.ts` (task 20), other application/persistence files, the GET/POST handlers tasks 9/17/20 own (only ADD `/api/tokens` + `/api/memory`).

## Approach
- Inherit ADR-001 (persistence adapters; `mem-reader` is **read-only** — V1 non-goal is editing memory). Mem file-store layout (plan §3): `<root>/facts/<slug>-<ulid>.md` + `episodes/`, frontmatter + body — reuse `@agentry/memory`'s file-store shapes if cleanly importable, else parse with the frontmatter regex (verify the layout against `packages/memory/src/persistence/file-store.ts`, recalled two-root routing: global + project).
- **Tokens risk (plan §7.3):** the transcript source (Claude Code session transcripts, the `session-report` source) is the **least-pinned contract** — `transcript-reader` must **verify the on-disk location/shape and degrade gracefully** if absent (don't assume; an empty `TokenSeries` + a good empty-state is acceptable for V1). If the shape is unstable enough to block, flag for a research spike — do not guess.
- The two GET handlers append to `routes.ts` additively.

## Acceptance
- `/api/memory` returns read-only browse/search over the real mem file-store (project + global roots); `/api/tokens` returns a `TokenSeries` from transcripts, or a clean empty series if the source is absent (graceful degrade).
- `mem-reader` performs NO writes (read-only verified). Unit test on a fixture mem store.
- Advances AC8 (Tokens/Memory data). Verifier curls both endpoints.
