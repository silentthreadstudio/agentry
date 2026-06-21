---
title: DocNode + typed edges + legend + hover-highlight + live-execution overlay
status: done
lockedBy: implementer
assignee: implementer
version: df6bba46c1c55bec
---

---
phase: 2
kind: feature
status: todo
deps: [12]
parallel_safe_with: []
---

## Goal
Render the graph's visual layer: the custom `DocNode` (status/agent/version; pulse/dim/lit), the four typed edges + a legend (`derives|depends-on|blocks|satisfies` visually distinct), hover-highlight of a node's edges, and the live-execution overlay (in-progress pulse, blocks-edge glow) driven by the ws stream. The visual half of AC3 + the live overlay of AC7.

## Contract
- **owns:** `packages/workbench/web/src/routes/work/live/DocNode.tsx`, `packages/workbench/web/src/routes/work/live/edge-types.tsx`
- **exposes:** the React Flow `nodeTypes`/`edgeTypes` that task 12's `Panorama` registers (plug into the pinned data-prop shape from task 12); the legend component; the hover-highlight + live-overlay behavior.
- **must NOT touch:** `Panorama.tsx`/`layout-dagre.ts` (task 12 owns the canvas/layout — consume its pinned node/edge prop contract), `server/**`, the `doc/` drawer (Phase 3).

## Approach
- Inherit the prototype `design/prototype-app.html` (the typed-edge rendering + dark monochrome) — designer see-it loop, no UI ships unseen.
- `DocNode` shows status (the FLOW task status pill), agent, version; visual states pulse (in-progress) / dim (todo) / lit (done) driven by ws updates from task 10's `ws-client` and the live graph data. The four edge types are visually distinct + a legend names them.
- Live overlay: a `node-enter`/status change over ws updates the node's state visuals; a `blocks` edge glows when active. Uses the FLOW event shapes (`@agentry/flow/domain`, via the read-model) — node state derives from task status / events, not invented.
- Hover a node → highlight its connected edges.

## Acceptance
- The four edge types render visually distinct with a legend; hover highlights a node's edges; node visual state matches FLOW status.
- A live status change over ws flips the node visuals (pulse/dim/lit) with no reload.
- Closes the visual half of AC3 + the live-overlay half of AC7. Verifier opens a real run, hovers, and triggers a live change.
