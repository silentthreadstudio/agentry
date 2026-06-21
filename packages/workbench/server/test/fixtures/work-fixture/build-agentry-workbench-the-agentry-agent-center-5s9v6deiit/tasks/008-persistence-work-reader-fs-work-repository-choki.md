---
title: "persistence + work-reader: fs-work-repository + chokidar-watcher +
  work-reader"
status: done
lockedBy: implementer
assignee: implementer
version: 383f96e89ff59bba
---

---
phase: 1
kind: feature
status: todo
deps: [6]
parallel_safe_with: [7]
---

## Goal
Implement the file→read-model core: `fs-work-repository` (readdir/parse `.agentry/work/*` via the FLOW frontmatter regex), `chokidar-watcher` (watch `.agentry/` → debounced change events keyed by run), and the `work-reader` application service (parse one run dir → `{ summary, graph, docs }` using `buildGraph` + FLOW domain shapes).

## Contract
- **owns:** `packages/workbench/server/src/persistence/fs-work-repository.ts`, `packages/workbench/server/src/persistence/chokidar-watcher.ts`, `packages/workbench/server/src/application/work-reader.ts`
- **exposes:** `FsWorkRepository implements WorkRepository` (readdir runs, parse a run dir's `spec.md`/`plan.md`/`adr/`/`tasks/`/`run-state.json` → frontmatter+body via FLOW's `FRONTMATTER` regex); `ChokidarWatcher implements Watcher` (debounced, run-keyed change events); `WorkReader.read(runId) → { summary: RunSummary, graph: GraphModel, docs }`. Pin: the `WorkReader` method names that `routes`/`ws` (task 9) call.
- **must NOT touch:** `domain/` (task 6 owns ports/graph — implement against them), `transport/`, `instance/`, `index.ts`, the other `application/` services (event-store/gate-inbox/write-service/token-reader are Phase 3/4).

## Approach
- Inherit ADR-001 (persistence adapters implement task 6's ports; `work-reader` is pure of HTTP/ws) + ADR-005 (reuse `@agentry/flow`'s `FRONTMATTER` regex + `domain/` shapes — do NOT fork the parser; recalled "harden both ends of a shared-file seam"). Read `packages/flow/src` for the exact regex + run-dir layout (`run-pointer.ts` `runDir()`, `task-file-store.ts`).
- Phase 1 scope: enough to produce `RunSummary` (status/shape/agents) for the Works list and a `GraphModel` for an opened work. `work-reader` calls `buildGraph` (task 6).
- The watcher is the live-loop trigger (AC7); Phase 1 wires it to `ws` in task 9. Debounce per the plan.

## Acceptance
- `FsWorkRepository` lists every `.agentry/work/*` run and parses a run dir into frontmatter+body matching FLOW's on-disk shapes (test against a real run fixture).
- `WorkReader.read` returns a `RunSummary` + `GraphModel` for a fixture run; `ChokidarWatcher` fires a run-keyed debounced event on a file change.
- Advances AC2 (Works lists real runs) + AC7 (the watch trigger). Unit test on a fixture run dir.
