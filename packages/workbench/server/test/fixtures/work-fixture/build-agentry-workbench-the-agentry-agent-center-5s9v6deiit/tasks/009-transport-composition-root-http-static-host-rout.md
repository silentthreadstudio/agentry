---
title: "transport + composition root: http static + host-router + ws + routes +
  index.ts"
status: done
lockedBy: implementer
assignee: implementer
version: 685653f92efa5630
---

---
phase: 1
kind: feature
status: todo
deps: [6, 7, 8]
parallel_safe_with: []
---

## Goal
Wire the transport edges and the composition root: `http` (serve `plugin/workbench/web/` static + REST), `host-router` (`<id>.localhost` Host → run context), `ws` (push `WsMessage` per run), `routes` (the Phase-1 endpoints), and `index.ts` (lock → wire adapters → start transports). Makes the spine demoable end-to-end.

## Contract
- **owns:** `packages/workbench/server/src/transport/http.ts`, `packages/workbench/server/src/transport/host-router.ts`, `packages/workbench/server/src/transport/ws.ts`, `packages/workbench/server/src/transport/routes.ts`, `packages/workbench/server/src/index.ts` (replacing the Phase-0 `/healthz`-only shell with the real composition root)
- **exposes:** the Phase-1 REST surface — `GET /healthz`, `GET /api/works`, `GET /api/work/:id/graph`, `GET /api/context` (run id bootstrap, ADR-002); static serve of the built web app; the `ws` channel pushing `WsMessage` keyed to a run; `host-router` parsing the leading DNS label off `Host` and attaching run context. Pin the endpoint paths — the web api-client (task 10) consumes them.
- **must NOT touch:** `domain/`, `persistence/`, `application/`, `instance/` internals (consume their pinned exposes only). The write endpoints (`/comment`,`/artifact`,`/takeover`) + their routes are Phase 3 (task 17) — leave room, don't add them.

## Approach
- **Routing = `*.localhost` host-routing EXACTLY as ADR-002 specifies — NO path-routing fallback in V1** (user gate decision, threaded in). `host-router` parses `<id>.localhost` → run id, validates through **FLOW's `assertSafeSegment`** (traversal guard — reuse, don't reinvent), attaches run context. Bare `localhost:4317` / `workbench.localhost` → Works home (no run context). The same built SPA serves every host; run id injected via `/api/context` (or `<meta name="agentry-run">`).
- `index.ts` composition root (ADR-001): call task 7's `port-lock` (EADDRINUSE ⇒ already-up exit path), write task 7's pidfile, wire task 8's `FsWorkRepository`+`ChokidarWatcher`+`WorkReader`, start http+ws. The watcher → `ws` push is the live-loop seam (AC7).
- Static serve resolves `plugin/workbench/web/` relative to the bundle (`CLAUDE_PLUGIN_ROOT`/import.meta.url), ADR-003.
- Same-package typecheck caveat (recalled): run the authoritative server typecheck after this wave, not per-file.

## Acceptance
- `node plugin/workbench/server/index.js` binds `:4317`, serves the web app at `localhost:4317`, answers `/api/works` with real runs and `/api/work/:id/graph` with a `GraphModel`.
- A request to `<id>.localhost:4317` resolves run context via `host-router` (Host label → run id, `assertSafeSegment`-guarded); a poisoned label is rejected.
- A file change under `.agentry/work/<id>/` pushes a `WsMessage` on that run's `ws` connection.
- Closes the server side of AC1/AC2; advances AC7 (ws push). Verifier curls the endpoints + checks host-routing.
