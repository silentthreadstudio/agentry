---
title: "page: Memory (read-only browse/search of the mem store)"
status: done
lockedBy: implementer
assignee: implementer
version: f2f38fbd5c5892e2
---

---
phase: 4
kind: feature
status: todo
deps: [21, 10]
parallel_safe_with: [22, 23, 24]
---

## Goal
Build the Memory page — read-only browse/search over the `mem` file-store (facts + episodes, project + global) from task 21's `mem-reader`. Dark + calm (AC8). Editing memory is a V1 non-goal — read-only.

## Contract
- **owns:** `packages/workbench/web/src/routes/Memory.tsx`
- **exposes:** the Memory sidebar page (consumes `/api/memory`) with browse + search, read-only.
- **must NOT touch:** sibling pages, the shell/design-system (task 10), `server/**`.

## Approach
- Inherit the calm design law (VISION §3) + the V1 non-goal (**no editing memory** — read-only browse/search only). Designer see-it loop against `prototype-app.html`. Consume task 10's primitives (incl. `SearchInput`) + `/api/memory` (task 21) typed by `shared` (task 1).
- Browse facts + episodes across the two roots (project `.agentry/memory` + global `~/.agentry/memory`); search filters client-side or via the endpoint.
- Empty state is a good state.

## Acceptance
- Memory renders read-only browse/search over the real mem store (project + global); no write affordance (AC8 + non-goal).
- Designer confirms against the prototype. Verifier loads Memory and searches.
