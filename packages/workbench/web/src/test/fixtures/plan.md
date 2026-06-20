# Plan — `@agentry/workbench`, the Agent Center V2

**Problem (one line).** Build a per-project, single-instance, named-domain React+Vite+Tiptap+React-Flow web app
over a thin stateless Node file-watching service that renders, edits, comments-on, and approves the FLOW v1
`.agentry/work/*` seams — files stay truth.

## 1. Approach

This is a **large arc with many actors** (watch / host-route / lock-enforce / aggregate / graph / editor / diff).
The floor is set by those actors, not by a file count — it earns full ports-and-adapters structure on the server
and a layered component structure on the web.

The single most important output is the **phasing**:

1. Each phase is an independently verifiable, demoable increment.
2. Riskiest and foundational concerns come first.
3. No phase advances on vibes — every gate is *acceptance-checked*.

## 2. Architecture map

- **server** — ports-and-adapters, stateless over the files (ADR-001).
- **web** — a layered React SPA: `routes/` over `design-system/` over `api/`.
- **shared** — the cross-cutting `@agentry/workbench-shared` contract types.

> The dependency arrow points inward: `domain` imports nothing; `application` imports `domain`;
> `persistence` and `transport` import both; `index` wires them.
