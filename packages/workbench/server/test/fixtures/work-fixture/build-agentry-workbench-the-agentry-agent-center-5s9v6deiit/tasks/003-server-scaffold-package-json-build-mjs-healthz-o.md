---
title: "server scaffold: package.json + build.mjs + /healthz-only server"
status: done
lockedBy: implementer
assignee: implementer
version: 5b13c25fa2e10da8
---

---
phase: 0
kind: build
status: todo
deps: [2]
parallel_safe_with: [1, 4, 5]
---

## Goal
Scaffold the server half: `packages/workbench/server` package + an esbuild `build.mjs` (mirroring `packages/memory/build.mjs`) that bundles a minimal `/healthz`-only Node server → committed `plugin/workbench/server/index.js` (+ `.srchash`), proving the esbuild artifact + lockstep (ADR-003).

## Contract
- **owns:** `packages/workbench/server/package.json`, `packages/workbench/server/tsconfig.json`, `packages/workbench/server/build.mjs`, `packages/workbench/server/src/index.ts` (minimal composition root: bind, serve `/healthz` → 200), `plugin/workbench/server/index.js`, `plugin/workbench/server/.srchash` (committed dist)
- **exposes:** the esbuild build command (`node server/build.mjs`) and the committed `plugin/workbench/server/index.js` entry the `/agentry:workbench` command will spawn; a running server answering `GET /healthz`.
- **must NOT touch:** `scripts/` (tasks 2,4), `web/` (task 5), `shared/` (task 1). The full ports-and-adapters tree (`domain/application/persistence/transport/instance`) is Phase 1+ — this task ships only the minimal `index.ts`.

## Approach
- Inherit ADR-001 (ports-and-adapters — but only the `index.ts` shell now), ADR-003 (esbuild: ESM, `target: node24`, `createRequire` banner, `node:*` external; mirror `packages/memory/build.mjs` byte-for-byte in shape). Read `packages/memory/build.mjs` first.
- `package.json`: name `@agentry/workbench-server`, `workspace:*` dep on `@agentry/flow` (ADR-005) and the shared pkg (task 1) — wire the deps even though the minimal server doesn't use them yet, so Phase 1 doesn't re-touch package.json.
- `build.mjs` calls the extended `bundleSrcHash` (task 2) with `server/src` + `@agentry/flow` coverage to stamp `server/.srchash`.
- Commit the dist (tracked, ADR-003) — `plugin/` is shipped payload.

## Acceptance
- `node packages/workbench/server/build.mjs` (or via the package build script) produces `plugin/workbench/server/index.js` + `.srchash`.
- `node plugin/workbench/server/index.js` starts and `GET /healthz` returns 200.
- Advances AC9 (server artifact + lockstep). Pairs with task 4 for the green `dist-lockstep (server)` row.
