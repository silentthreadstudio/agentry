---
title: "pages: Activity (per-work timeline) + Agents (roster across runs)"
status: done
lockedBy: implementer
assignee: implementer
version: 0ba30f9d18b2aa25
---

---
phase: 4
kind: feature
status: todo
deps: [20, 10]
parallel_safe_with: [23, 24, 25]
---

## Goal
Build the Activity page (this work's event timeline, fills the WorkLayout Activity tab) and the Agents page (the roster across runs) — both projections of task 20's `event-store` fold. Dark + calm (AC8).

## Contract
- **owns:** `packages/workbench/web/src/routes/work/Activity.tsx`, `packages/workbench/web/src/routes/Agents.tsx`
- **exposes:** the Activity tab body (consumes `/api/events?run=<id>`) + the Agents sidebar page (consumes `/api/events` + `/api/agents`). Fills the route slots task 10's shell left.
- **must NOT touch:** `Tokens.tsx`/`Memory.tsx`/`Gates.tsx` (tasks 23/24/25), the shell/design-system (task 10 — consume primitives), `server/**`.

## Approach
- Inherit the calm design law (VISION §3) — dark, calm, empty states are good states. Designer see-it loop against `prototype-app.html`. Consume task 10's design-system primitives + the pinned `/api/events`/`/api/agents` endpoints (task 20) typed by `shared` (task 1).
- Activity = the per-work timeline (`EventView[]` filtered to the run); Agents = the cross-run roster (`AgentView[]` + activity).

## Acceptance
- Activity renders this work's event timeline from real `events.jsonl`; Agents renders the roster across runs — both dark/calm with good empty states (AC8).
- Designer confirms against the prototype. Verifier loads both pages against real data.
