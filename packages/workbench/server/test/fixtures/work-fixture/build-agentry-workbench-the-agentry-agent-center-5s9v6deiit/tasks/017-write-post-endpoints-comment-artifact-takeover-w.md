---
title: "write POST endpoints: /comment, /artifact, /takeover (wire write-service
  into transport)"
status: done
lockedBy: implementer
assignee: implementer
version: 9197650d0a026da3
---

---
phase: 3
kind: feature
status: todo
deps: [15, 9]
parallel_safe_with: [16]
---

## Goal
Add the three write endpoints to the transport layer — `POST /api/work/:id/comment`, `POST /api/work/:id/artifact`, `POST /api/work/:id/takeover` — wiring task 15's `WriteService` behind the host-router, and pushing the new version + a `WsMessage` on success.

## Contract
- **owns:** the write-route additions in `packages/workbench/server/src/transport/routes.ts` (the three POST handlers; this task EXTENDS the file task 9 created — task 9 deliberately left room and added only GETs)
- **exposes:** the three POST endpoints with their pinned request/response shapes (consumed by task 16's DocDrawer save + Take over, task 18's comment submit, task 19's diff accept/reject). On a successful artifact write, push the re-stamped `version` + a `doc-updated` `WsMessage` (AC7 link).
- **must NOT touch:** `write-service.ts`/`flow-writer.ts` (task 15 owns the logic — call it), the GET routes / `host-router` / `ws` / `index.ts` internals task 9 owns (only ADD the POST handlers; do not refactor task 9's code).

## Approach
- **Serialization caveat:** `routes.ts` is shared with task 9 (Phase 1, already merged) — but this task only *appends* the three POST handlers to a Phase-1 file, so there is no live overlap with a sibling. Confirm task 9's route structure on open and add alongside (verify-and-adjust, don't assume the exact shape).
- Each handler resolves its run from the host-router context (ADR-002 — host-scoped writes), validates the body, calls the matching `WriteService` method (task 15), and on success pushes over `ws`. The client is never trusted (ADR-006) — the route is a thin adapter; all enforcement is in `WriteService`.
- `/comment` builds the 3-way anchor from the request (originalText/headingAnchor/startLine sent by the web selection) — but the *enforcement/append* is task 15.

## Acceptance
- `POST /artifact` with a stale `baseVersion` returns a rejection; a fresh one writes + returns the new version + pushes a `doc-updated` ws message (AC6, AC7).
- `POST /comment` appends a `ReviewComment` to `.review/<gate>.annotations.json` (AC5); `POST /takeover` flips the lock (AC4).
- Host-scoped: a write on `<id>.localhost` resolves to that run. Verifier curls the three endpoints against a fixture run.
