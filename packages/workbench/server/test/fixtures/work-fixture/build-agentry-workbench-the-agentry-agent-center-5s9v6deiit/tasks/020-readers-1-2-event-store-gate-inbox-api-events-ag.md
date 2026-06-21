---
title: "readers (1/2): event-store + gate-inbox + /api/{events,agents,gates}
  endpoints"
status: done
lockedBy: implementer
assignee: implementer
version: 34714f75392c26c0
---

---
phase: 4
kind: feature
status: todo
deps: [6, 8, 9]
parallel_safe_with: [21]
---

## Goal
Build the run-aggregation readers: `event-store` (fold every run's `events.jsonl` + hook lines via FLOW's `parseLogLine` → a per-project timeline + per-run timeline; powers Activity/Agents) and `gate-inbox` (scan every run's `.review/*.annotations.json` → the waiting-on-you list). Expose them via `/api/events`, `/api/agents`, `/api/gates`. The shared reader seam — sequenced before the pages (plan §6).

## Contract
- **owns:** `packages/workbench/server/src/application/event-store.ts`, `packages/workbench/server/src/application/gate-inbox.ts`, and the GET handlers `/api/events`, `/api/agents`, `/api/gates` appended to `transport/routes.ts`
- **exposes:** `EventStore.timeline(runId?)` → `EventView[]` (one fold powers both per-work Activity and cross-run Agents — a projection, not five ad-hoc scanners) + the agent roster (`AgentView[]` from `run-state.json` across runs); `GateInbox.open()` → `GateItem[]` (open = waiting-on-you, with jump-to-doc-at-gate metadata). Pin the endpoint paths + the `EventView`/`AgentView`/`GateItem` read-model shapes (task 1's `shared` types). Consumed by task 22 (Activity/Agents) + task 23 (Gates).
- **must NOT touch:** `token-reader.ts`/`mem-reader.ts` (task 21), `write-service`/`work-reader` (tasks 8/15), `host-router`/`ws`/`index.ts` internals (only ADD the three GET handlers to `routes.ts`).

## Approach
- Inherit ADR-001 (application services over ports, pure of HTTP) + ADR-005 (event shapes from `@agentry/flow/domain`). Reuse FLOW's `parseLogLine` (drops empty-`agent` main-session lines) — do NOT reimplement event parsing. The two `events.jsonl` shapes (FLOW + hook backstop) discriminate via `parseLogLine` (plan §3).
- `event-store` is the *one fold* Activity/Agents project from (plan §2.2) — build it as a single timeline fold, not per-page scanners.
- `gate-inbox`: open items = unresolved review comments / pending gates; carry the jump-to-doc-at-gate pointer.
- The three GET handlers append to `routes.ts` (Phase-1 file) — additive, no overlap with the write handlers (task 17) which append separately; confirm structure on open.

## Acceptance
- `/api/events` returns a folded timeline from real `events.jsonl` (per-project + per-run); `/api/agents` returns the roster across runs; `/api/gates` returns the open waiting-on-you items.
- `parseLogLine` is reused (empty-agent main-session lines dropped). Unit test on a fixture run's `events.jsonl` + `.review/`.
- Advances AC8 (the data behind Activity/Agents/Gates). Verifier curls the three endpoints.
