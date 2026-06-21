---
id: 007
title: "@agentry/flow exposes internal 'live-types' subpath exports for workspace consumers"
status: accepted
date: 2026-06-19
supersedes-note: refines ADR-005 tier 1 (reuse flow's domain shapes) with the concrete resolution mechanism
---

# ADR-007 — How workbench packages consume `@agentry/flow`'s domain shapes

## Context
ADR-005 tier 1 mandates the workbench reuse `@agentry/flow`'s `domain/` shapes (`FlowTaskStatus`,
`AgentState`, `FlowEvent`, `ReviewComment`, `computeVersion`, the task-file render) rather than
redeclaring them — so the two writers stay byte-compatible. But `@agentry/flow`'s `package.json` ships
**no `main`/`types`/`exports`**: it builds only to the committed bundled MCP `plugin/flow/index.js`
(esbuild from an explicit `entryPoints: ["src/index.ts"]`) and has no `dist`. So `import … from
"@agentry/flow/domain/*"` does not resolve under NodeNext. Task 001's implementer surfaced this and
confined a temporary `tsconfig` `paths` shim to its own package, flagging that every server/web task
would otherwise reinvent the same shim.

## Decision
Add internal **source-pointing subpath exports** to `packages/flow/package.json`:

```json
"exports": { "./*": "./src/*.ts", "./package.json": "./package.json" }
```

Consumers import `@agentry/flow/domain/events`, `@agentry/flow/domain/version`, etc., resolving to flow's
TypeScript source. The per-package shim in `workbench/shared/tsconfig.json` is removed — one mechanism.

## Alternatives
- **Per-package `tsconfig` `paths` shim (rejected):** drift — every consuming package (shared, server)
  repeats flow-internal path knowledge; brittle, and `paths` resolution diverges from real package
  resolution (esbuild/Bundler wouldn't honor it).
- **Give flow a real `tsc` dist build + `exports` → dist (rejected for V1):** matches `@agentry/core`'s
  pattern but adds a second build product to flow, a new dist to commit/lockstep, and ceremony for a
  leaf package that today only bundles. Heavier than the need.
- **A `src/domain/index.ts` barrel + `exports` (rejected):** adds a new file under flow's `src/`, which
  changes `bundleSrcHash(flow)` → would force a flow rebuild + `.srchash` re-stamp for a file the bundle
  never imports. The wildcard subpath export touches only `package.json` (not hashed) → zero lockstep
  impact.

## Consequences
- **No lockstep impact on flow:** `package.json` is not in the hashed `src/` tree and the bundle's
  explicit entryPoint is unchanged → `plugin/flow/index.js` + its `.srchash` are untouched. (Verified:
  `check-plugin` flow row stays green without a flow rebuild.)
- Workbench server/web tasks import flow's domain shapes + `computeVersion`/render directly; esbuild
  inlines the needed source into the server bundle (and `bundleSrcHash(server)` already covers
  `@agentry/flow/src` transitively, ADR-003).
- The exports are source `.ts` ("live types"), appropriate for an internal monorepo package consumed by
  TS tooling only; flow is never published as a standalone npm package.
- Type-only imports must use `import type` under `verbatimModuleSyntax` (already the convention).
