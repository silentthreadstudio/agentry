---
title: "page: Tokens (charts from session transcripts)"
status: done
lockedBy: implementer
assignee: implementer
version: 6d561637d46754e9
---

---
phase: 4
kind: feature
status: todo
deps: [21, 10]
parallel_safe_with: [22, 23, 25]
---

## Goal
Build the Tokens page — charts of `TokenSeries` (per run/agent/day) from task 21's `token-reader`. Dark + calm (AC8). Degrades gracefully if the transcript source is absent.

## Contract
- **owns:** `packages/workbench/web/src/routes/Tokens.tsx`
- **exposes:** the Tokens sidebar page (consumes `/api/tokens`) with the usage charts.
- **must NOT touch:** sibling pages (`Activity/Agents/Gates/Memory`), the shell/design-system (task 10), `server/**`.

## Approach
- Inherit the calm design law (VISION §3); designer see-it loop against `prototype-app.html`. Consume task 10's primitives + `/api/tokens` (`TokenSeries`, task 21) typed by `shared` (task 1).
- **Risk (plan §7.3):** the transcript source is the least-pinned contract — this page must render a **good empty/degraded state** when `/api/tokens` returns an empty series (task 21 degrades gracefully). Tokens is the lowest-risk page and may ship last / degrade — do not block the phase on it.
- Charts: a small charting approach consistent with the repo (the self-eval dashboard uses a neutral-black canvas + semantic data colors, recalled — match that visual language). Add the chart dep to the web bundle only if needed.

## Acceptance
- Tokens renders `TokenSeries` charts from real transcripts, OR a clean empty/degraded state if the source is absent (AC8).
- Designer confirms against the prototype. Verifier loads Tokens.
