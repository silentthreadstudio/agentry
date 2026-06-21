---
title: "page: Gates (the waiting-on-you inbox, jump-to-doc-at-gate)"
status: done
lockedBy: implementer
assignee: implementer
version: 5268bb3fef70455e
---

---
phase: 4
kind: feature
status: todo
deps: [20, 10]
parallel_safe_with: [22, 24, 25]
---

## Goal
Build the Gates page — the waiting-on-you inbox of open review/gate items (task 20's `gate-inbox`), each jumping to the doc-at-gate. Dark + calm (AC8).

## Contract
- **owns:** `packages/workbench/web/src/routes/Gates.tsx`
- **exposes:** the Gates sidebar page (consumes `/api/gates`) with jump-to-doc-at-gate navigation into the work's Live/DocDrawer.
- **must NOT touch:** `Activity.tsx`/`Agents.tsx`/`Tokens.tsx`/`Memory.tsx` (sibling pages), the shell/design-system (task 10), `server/**`.

## Approach
- Inherit the calm design law (VISION §3); designer see-it loop against `prototype-app.html`. Consume task 10's primitives + the pinned `/api/gates` endpoint (task 20, `GateItem[]`) typed by `shared` (task 1).
- Each gate item carries the jump-to-doc-at-gate pointer (run + doc + gate) — clicking navigates to `<id>.localhost` and opens the doc at the gate (reuse task 16's DocDrawer open contract; navigate, don't re-implement).
- Empty state (no gates waiting) is a good state.

## Acceptance
- Gates renders the open waiting-on-you items from real `.review/` data; clicking one jumps to the doc at the gate (AC8).
- Designer confirms against the prototype. Verifier loads Gates against a run with open gates.
