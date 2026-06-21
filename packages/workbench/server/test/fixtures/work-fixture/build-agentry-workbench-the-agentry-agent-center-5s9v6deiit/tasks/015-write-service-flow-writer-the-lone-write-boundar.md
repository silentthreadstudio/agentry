---
title: "write-service + flow-writer: the lone write boundary (lock + optimistic
  concurrency, ADR-006)"
status: done
lockedBy: implementer
assignee: implementer
version: cea195ec6191b35a
---

---
phase: 3
kind: feature
status: todo
deps: [6, 8]
parallel_safe_with: [14]
---

## Goal
Build the single server-side write boundary: `write-service` (enforces the lock + optimistic concurrency for both writes — review comment + artifact edit, ADR-006) and `flow-writer` (the artifact/sidecar write adapter replicating FLOW's `TaskFileStore` render + `computeVersion`). The clobber-safety guarantee lives here, testable with fake ports.

## Contract
- **owns:** `packages/workbench/server/src/application/write-service.ts`, `packages/workbench/server/src/persistence/flow-writer.ts`
- **exposes:** `WriteService` with the two write paths — `addComment(...)` (append a `ReviewComment` with the 3-way anchor to `.review/<gate>.annotations.json`; allowed even when locked) and `writeArtifact({ run, kind/taskNo, baseVersion, newBody })` (re-read disk; reject if `status===in-progress` with `lockedBy`; reject if recomputed current version ≠ `baseVersion`; else write via `flow-writer` which re-stamps version) + `takeOver(...)` (the explicit server-performed lock transition). Pin: these method signatures + the request shapes task 17's POST routes call.
- **must NOT touch:** `transport/routes.ts` (task 17 owns the HTTP endpoints — this is pure application/persistence), `domain/` (task 6), the web serializer (task 14).

## Approach
- Inherit ADR-006 verbatim: **both invariants enforced server-side, client never trusted; freshness key = FLOW version hash carried opaquely.** Lock check re-reads task frontmatter from disk at write time (not open time). Optimistic concurrency recomputes current version via FLOW's `computeVersion` over normalized body + frontmatter-sans-version and rejects on mismatch. Take over = explicit lock transition, then write allowed. Comments allowed when locked.
- Inherit ADR-005: `flow-writer` reuses `@agentry/flow`'s shapes + `computeVersion` + the `TaskFileStore` render contract (replicate the render, do NOT call the FLOW MCP over stdio — separate processes). Read `packages/flow/src/.../task-file-store.ts` for the exact render.
- The body it writes must already be normalized (ADR-004 link) — the route passes the serializer's normalized output; `flow-writer` recombines untouched frontmatter + body and re-stamps `version`.
- Unit-test with fake ports (no fs/ws): a stale `baseVersion` rejects; an `in-progress` status rejects with `lockedBy`; Take over flips the lock; a fresh edit writes + bumps version.

## Acceptance
- A `writeArtifact` with a stale `baseVersion` is **rejected** (optimistic concurrency); a fresh one writes + bumps `version` (AC6).
- A write against `status===in-progress` is rejected with `lockedBy`; `takeOver` flips the lock then allows the write (AC4).
- `addComment` appends a valid `ReviewComment` even when locked (AC5).
- Closes the safety-boundary core of AC4/AC5/AC6. Verifier runs the fake-port unit suite.
