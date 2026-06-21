---
title: "web scaffold: package.json + vite.config + placeholder React app"
status: done
lockedBy: implementer
assignee: implementer
version: 455ca05d1f276ef4
---

---
phase: 0
kind: build
status: todo
deps: [2]
parallel_safe_with: [1, 3, 4]
---

## Goal
Scaffold the web half: `packages/workbench/web` package + `vite.config.ts` + a placeholder React app that `vite build`s → committed `plugin/workbench/web/` (+ `web/.srchash`), proving the Vite artifact + lockstep (ADR-003).

## Contract
- **owns:** `packages/workbench/web/package.json`, `packages/workbench/web/tsconfig.json`, `packages/workbench/web/vite.config.ts`, `packages/workbench/web/index.html`, `packages/workbench/web/src/main.tsx`, `packages/workbench/web/src/App.tsx` (placeholder "Workbench" shell — NOT the full router yet), `plugin/workbench/web/**` (committed Vite dist incl. `index.html` + `assets/`), `plugin/workbench/web/.srchash`
- **exposes:** `vite build` output at `plugin/workbench/web/` (the server static-serves it); `base: './'` so asset URLs resolve behind any `*.localhost` host. The real router shell (sidebar + tabs) is Phase 1 (task 8) — this is a placeholder so the build pipeline is provable now.
- **must NOT touch:** `server/`, `shared/`, `scripts/`. The Phase-1 web shell, routes, api/ws-client are owned by later tasks — keep `App.tsx` a deliberately thin placeholder.

## Approach
- Inherit ADR-003: `vite.config.ts` `base: './'`, build out-dir `../../plugin/workbench/web`. The web bundle has **no workspace deps** (ADR-005: web talks to server over the local read-model API, not at the type level) — so its `.srchash` uses task 2's no-workspace-walk path over `web/src`.
- `package.json` name `@agentry/workbench-web`; deps: react, react-dom, vite (the heavier UI deps — `@xyflow/react`, Tiptap, dagre — are added by the phases that use them; keep Phase 0 minimal).
- Stamp `web/.srchash` via `bundleSrcHash(..., { srcSubdir: 'src' })` (task 2) — wire it into the build script or have task 4's checkBundle compute it; match how mem/flow stamp.

## Acceptance
- `pnpm --filter @agentry/workbench-web build` (or the package's `vite build` script) produces `plugin/workbench/web/index.html` + hashed `assets/`.
- The placeholder app renders (a div with a recognizable title) when the built `index.html` is served.
- Advances AC9 (web artifact + lockstep). Pairs with task 4 for the green `dist-lockstep (web)` row.
