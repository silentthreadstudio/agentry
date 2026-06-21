---
title: root @agentry/workbench package + two checkBundle() calls in check-plugin.mjs
status: done
lockedBy: implementer
assignee: implementer
version: ff7668a3089991c3
---

---
phase: 0
kind: build
status: todo
deps: [2, 3, 4]
parallel_safe_with: [1]
---

## Goal
Tie the two-artifact build together under `packages/workbench/package.json` (`build = vite build && node server/build.mjs`) and add the two `checkBundle()` calls (`web`, `server`) to `scripts/check-plugin.mjs` so the gate emits green `dist-lockstep (web)` + `dist-lockstep (server)` rows — closing the Phase-0 lockstep loop (ADR-003, AC9 partial).

## Contract
- **owns:** `packages/workbench/package.json` (the orchestrating `@agentry/workbench` package with the two-step `build` script + `pnpm --filter @agentry/workbench build` entry), `scripts/check-plugin.mjs`
- **exposes:** `pnpm --filter @agentry/workbench build` producing BOTH committed artifacts; two new `checkBundle()` rows in the gate. Pin the row labels exactly: `dist-lockstep (web)` and `dist-lockstep (server)`.
- **must NOT touch:** `scripts/lib/src-hash.mjs` (task 2 owns the hash lib), the `packages/workbench/{web,server,shared}/**` sources (tasks 1,3,4) — this task only orchestrates + validates.

## Approach
- Read `scripts/check-plugin.mjs` first to learn the existing `checkBundle(pkgDir, distPath, srchashPath, label)` signature (ADR-003 says it already takes these args). Add:
  - web call: pkgDir `packages/workbench/web`, dist sentinel `plugin/workbench/web/index.html`, srchash `plugin/workbench/web/.srchash`, label `web` — using task 2's no-workspace-walk path.
  - server call: pkgDir `packages/workbench/server`, dist `plugin/workbench/server/index.js`, srchash `plugin/workbench/server/.srchash`, label `server` — with `@agentry/flow/src` transitive coverage.
- Inherit the **dist-lockstep standing rule**: any `packages/workbench/{web,server}/src` (or `@agentry/flow/src`) change ⇒ rebuild + commit the artifact + `.srchash` in the same change.
- Recalled: dist-lockstep is **content-hash based** (`.srchash` content, not mtimes) — a stale warning = real drift.

## Acceptance
- After tasks 3+4 build their dists, `node scripts/check-plugin.mjs` is **green** and shows `dist-lockstep (web)` + `dist-lockstep (server)` rows.
- Touching a `web/src` or `server/src` file (without rebuild) flips the matching row to **stale**; rebuilding restores green. The mem/flow rows are unaffected (regression).
- Closes the Phase-0 demo of AC9 (pipeline + gate on an empty app). Verifier runs `check-plugin` and the stale-then-rebuild flip.
