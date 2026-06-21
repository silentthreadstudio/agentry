---
title: "shared package: the read-model contract types (ADR-005 tier 2)"
status: done
assignee: implementer
version: 09bbbaaf66cf9d04
---

---
phase: 0
kind: feature
status: todo
deps: []
parallel_safe_with: [2, 3, 4, 5]
---

## Goal
Stand up `packages/workbench/shared/` — the single-owner home for the server↔web read-model contract types (ADR-005 tier 2), so both halves of the package import one non-drifting definition.

## Contract
- **owns:** `packages/workbench/shared/package.json`, `packages/workbench/shared/tsconfig.json`, `packages/workbench/shared/src/types.ts`, `packages/workbench/shared/src/index.ts` (barrel)
- **exposes:** the TypeScript read-model surface consumed by server (`application/`, `transport/`) and web (`api/`): `RunSummary`, `GraphModel { nodes, edges }`, `GraphNode`, `GraphEdge` (with the four edge kinds `derives|depends-on|blocks|satisfies`), `DocModel { frontmatter, body, version, lock }`, `GateItem`, `EventView`, `AgentView`, `TokenSeries`, and the websocket envelope `WsMessage` (discriminated: `file-changed | doc-updated | diff-ready`). Pin these names exactly — siblings consume them.
- **must NOT touch:** any `server/`, `web/`, `scripts/` files (sibling-owned).

## Approach
- Inherit ADR-005: these are *local transport types*, NOT in `@agentry/core` and NOT duplicating FLOW's `domain/` shapes. Where a field carries a FLOW on-disk shape (e.g. a review decision, a task status, an event), re-export / reference `@agentry/flow`'s `domain/` types rather than redefining them — keep `shared` a thin contract that leans on `@agentry/flow` for the closed unions.
- `package.json` name `@agentry/workbench-shared` (or the repo's chosen scope — match `@agentry/flow`/`@agentry/memory` conventions); `workspace:*` dep on `@agentry/flow` for the FLOW shapes it references. Type-only package; no build artifact of its own (consumed via TS project refs / direct src import — match how flow/core are consumed).
- This is the **shared seam owned by exactly one task** (plan §6). Define the names precisely; downstream tasks `deps: [1]`.

## Acceptance
- `packages/workbench/shared/src/types.ts` defines every name in **exposes**; `tsc --noEmit` over the shared package is clean.
- No type is duplicated from `@agentry/flow/domain` or `@agentry/core` (ADR-005); FLOW shapes are imported, not re-declared.
- Advances AC2/AC3/AC4/AC8 indirectly (the contract every read-model rides on); no AC is *closed* by this task alone — it is the seam.
