---
title: "Panorama: React Flow canvas + Dagre auto-layout (no overlapping nodes)"
status: done
lockedBy: implementer
assignee: implementer
version: bf471450ff2cc505
---

---
phase: 2
kind: feature
status: todo
deps: [1, 9, 10]
parallel_safe_with: []
---

## Goal
Build the Live panorama: the React Flow canvas (`Panorama.tsx`) over a run's `GraphModel`, with `layout-dagre.ts` computing non-overlapping node positions + fitView. The structural half of AC3 (Dagre auto-layout, no overlapping nodes).

## Contract
- **owns:** `packages/workbench/web/src/routes/work/live/Panorama.tsx`, `packages/workbench/web/src/routes/work/live/layout-dagre.ts`
- **exposes:** the `Panorama` route component (fills the Live tab slot the task-10 shell left) consuming `GraphModel` from `/api/work/:id/graph`; `layout-dagre.ts` = `GraphModel → positioned nodes/edges → Dagre → fitView`. Pin: the node/edge data prop shape that task 13's `DocNode`/`edge-types` plug into (the React Flow `nodeTypes`/`edgeTypes` contract).
- **must NOT touch:** `DocNode.tsx`, `edge-types.tsx` (task 13 owns the visual node/edge rendering + legend + live overlay), the `doc/` drawer (Phase 3), `server/**`.

## Approach
- Inherit VISION §4 (routing decision = root, graph shape = routing shape) + the prototype `design/prototype-app.html` (typed-edge rendering target). Add `@xyflow/react` + `dagre` as web deps (Phase-2 deps; ADR-003 — they bundle into the Vite assets).
- `layout-dagre.ts` is the *only* place layout runs (SRP): build nodes/edges from `GraphModel`, run Dagre, emit positions, fitView. Note the VISION escape hatch: large DAGs may later need ELK — out of scope for V1, leave a clean seam.
- Design see-it loop (designer, plan §1): render a real decompose+verify run's DAG and confirm no overlapping nodes against the prototype.
- Wire ws: subscribe via task 10's `ws-client` so the canvas re-renders on graph changes (the live re-render mechanism; the node-state *overlay* visuals are task 13).

## Acceptance
- Opening a real run's Live renders the full DAG via React Flow with **no overlapping nodes** (Dagre), fit to view.
- A live `node-enter`/graph change over ws re-renders without reload.
- Closes the layout half of AC3 + advances AC7 (live graph). Verifier opens a real run and inspects the rendered graph.
