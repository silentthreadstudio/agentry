---
title: "server domain: ports.ts + graph.ts (the pure read-model core)"
status: done
assignee: implementer
version: 827d74c6c85179d5
---

---
phase: 1
kind: feature
status: todo
deps: [1, 3]
parallel_safe_with: [7]
---

## Goal
Define the server's pure `domain/` layer — the ports the application depends on, and `buildGraph()` that turns a run's parsed files into a `GraphModel` (nodes + typed edges). PURE, no I/O (ADR-001). This is the server-internal shared seam every Phase-1+ application/transport task depends on.

## Contract
- **owns:** `packages/workbench/server/src/domain/ports.ts`, `packages/workbench/server/src/domain/graph.ts`
- **exposes:** the port interfaces — `WorkRepository`, `Watcher`, `Transport`, `MemSource`, `TranscriptSource`, `Clock` (pin these names; persistence/transport/application tasks implement/consume them) — and `buildGraph(runFiles) → GraphModel` producing nodes (routing/spec/adr/plan/task) + the four typed edges (`derives|depends-on|blocks|satisfies`) derived from frontmatter `deps`/`satisfies` (routing decision = root, so graph shape = routing shape, VISION §4).
- **must NOT touch:** `application/`, `persistence/`, `transport/`, `instance/`, `index.ts` (sibling/later tasks). `domain` imports nothing from those layers — dependency arrow points inward (ADR-001).

## Approach
- Inherit ADR-001 (pure domain, ports-and-adapters) + ADR-005 (read-model types come from the `shared` pkg, task 1; FLOW on-disk shapes come from `@agentry/flow/domain` — import, don't redefine). `GraphModel`/`GraphNode`/`GraphEdge` are the shared-pkg types; `graph.ts` *populates* them.
- `buildGraph` is the *only* place frontmatter becomes nodes/edges (SRP, plan §2.1). Phase 1 needs only enough graph for an opened work to render an (empty/skeletal) Live; the rich typed-edge rendering is Phase 2's `graph.ts` extension — but define the full edge-kind derivation here since it's pure and testable now. Note: plan §2.1 lists `graph.ts` once; Phase 2 task 12 extends/consumes it for live overlay — coordinate via deps, this task owns the file.
- Domain is unit-testable with plain data (no fs/ws).

## Acceptance
- `domain/ports.ts` declares every port in **exposes**; `domain/graph.ts` `buildGraph` maps a fixture run's frontmatter into a `GraphModel` with correct node kinds and the four edge types.
- `tsc --noEmit` clean; no import from `application/persistence/transport`.
- Advances AC3 (the graph derivation) + underpins AC2. Unit test on a fixture run proves edge typing.
