---
id: ADR-003
title: Two-artifact committed dist (Vite web + esbuild server) under the no-node_modules rule, validated by checkBundle
status: accepted
date: 2026-06-19
deciders: architect
---

# ADR-003 — Two-artifact committed dist (Vite UI + esbuild server) and how `check-plugin` validates it

## Context

Every shipped MCP today is **one** committed bundle (`plugin/mem/index.js`, `plugin/flow/index.js`) with a
`.srchash` that `checkBundle()` recomputes via `bundleSrcHash(pkgDir)` (recalled packaging rules + the
transitive-dep fix). The hard rules: **no shipped `node_modules`**, pure-JS deps esbuild-bundled into committed
dist, `node:sqlite` external, Node ≥ 24, dist-lockstep enforced per package (AC9). The Workbench breaks the
one-artifact assumption: it has **two** build outputs of **different kinds** —

- a **web UI** that is a *static asset graph* (Vite → hashed JS/CSS chunks under `assets/`, an `index.html`),
  whose third-party deps (React, `@xyflow/react`, Tiptap, dagre) are **bundled into those static assets** — they
  ship as built JS, not as `node_modules`, so the no-node_modules rule is satisfied by the same principle the MCPs
  use (bundling), just via Vite instead of esbuild;
- a **server** that is a *single Node entry* — esbuild-bundled exactly like the MCPs (ESM, `createRequire` banner
  for bundled CJS, externals for Node builtins), one `index.js`.

`bundleSrcHash` currently assumes one `src` tree per package and hashes the package's own `src` + workspace-dep
`src`. The workbench package has two source roots (`web/`, `server/`) and one transitive workspace dep
(`@agentry/flow`, used by the server for the FLOW shapes — ADR-001).

## Decision

**One committed dist directory, two artifacts, two `.srchash` stamps, two `checkBundle()` calls.**

Committed layout under `plugin/workbench/`:

```
plugin/workbench/
  web/            # Vite build output: index.html + assets/<hashed>.{js,css}   (committed)
  web/.srchash    # bundleSrcHash over packages/workbench/web/src (+ no workspace deps)
  server/index.js # esbuild bundle of packages/workbench/server/src/index.ts   (committed)
  server/.srchash # bundleSrcHash over packages/workbench/server/src + @agentry/flow/src
```

- `pnpm --filter @agentry/workbench build` runs **two steps**: (1) `vite build` (root `packages/workbench/web`,
  `base: './'` so the asset URLs are relative — works behind any `*.localhost` host) → `plugin/workbench/web/`;
  (2) `node server/build.mjs` (esbuild, mirroring `packages/memory/build.mjs` byte-for-byte in shape: ESM,
  `target: "node24"`, `createRequire` banner, externals for `node:*`) → `plugin/workbench/server/index.js`. Each
  step stamps its own `.srchash` via `bundleSrcHash`.
- The server serves `plugin/workbench/web/` as the static UI (transport/http, ADR-001), resolving it relative to
  the server bundle (`CLAUDE_PLUGIN_ROOT`/import.meta.url) — the two artifacts ship side by side and the server
  knows where the UI is.
- **`bundleSrcHash` gains an optional `srcSubdir` (or accepts an explicit src path)** so it can hash a non-`src`
  root and skip the workspace-dep walk when there is none (the web build has no workspace deps; the server build
  has `@agentry/flow`). This is a small, additive change to `scripts/lib/src-hash.mjs` that keeps the existing
  mem/flow callers byte-identical (default behavior unchanged).
- **`check-plugin.mjs` adds two `checkBundle()` calls** — one for `web` (dist = `plugin/workbench/web/index.html`,
  the existence sentinel + the hashed `assets/` dir), one for `server` (dist = `plugin/workbench/server/index.js`).
  The existing `checkBundle` signature already takes `(pkgDir, distPath, srchashPath, label)`; the web call points
  at the web src root and `index.html`, the server call at the server src root + `@agentry/flow` coverage. Both
  produce the same `dist-lockstep (web)` / `dist-lockstep (server)` green rows or a stale warning.

The committed dist is **tracked** (not gitignored) — recalled `.gitignore` fact: `.agentry/work` and `.docs` are
gitignored, but `plugin/` is the shipped payload and must be committed, exactly like `plugin/mem` / `plugin/flow`.

## Alternatives

1. **One esbuild bundle for everything (server + inlined UI).** Rejected: React/React-Flow/Tiptap want Vite's
   asset pipeline (code-splitting, CSS handling, the React Flow stylesheet); cramming a SPA through esbuild as one
   blob loses the dev server and fights the ecosystem. Two tools, each for its job.
2. **Ship the web as a dev server / build-on-launch.** Rejected: violates the committed-dist + zero-install rule
   (a marketplace install must run with no build step) and the no-node_modules rule. The UI must be pre-built and
   committed, like every other plugin artifact.
3. **A single `.srchash` covering both artifacts.** Rejected: the two artifacts have different src roots and
   different rebuild triggers; a single hash couldn't tell you *which* artifact is stale, and an unrelated web
   change would force the gate to claim the server bundle is stale. Two stamps = two precise signals.
4. **Keep `bundleSrcHash` untouched and hash via a wrapper.** Rejected: the additive `srcSubdir` param is smaller
   and keeps the dist-lockstep logic in one place; a wrapper would duplicate the workspace-dep-walk subtlety the
   transitive-dep fix got right.

## Consequences

- **Good:** the existing dist-lockstep guarantee extends to the Workbench with two precise green rows; a change to
  `@agentry/flow/src` correctly marks the *server* bundle stale (the transitive coverage that already saved the
  v0.2 kind-enum drift), while a web-only change marks only the web bundle stale.
- **Good:** no shipped `node_modules` — Vite bundles the UI deps into static assets, esbuild bundles the server
  deps into one file; the rule holds for both.
- **Cost:** the committed `plugin/workbench/web/` is a directory of hashed assets (larger, churns on every UI
  change) rather than one file. Acceptable for a shipped UI; it is the standard Vite output and stays diff-able.
- **Cost:** a tiny additive change to `scripts/lib/src-hash.mjs` and two new `checkBundle` calls in
  `check-plugin.mjs` — both covered by their own task with the mem/flow callers regression-checked unchanged.
- **Dist-lockstep discipline:** any `packages/workbench/{web,server}/src` change (or an `@agentry/flow/src` change
  the server inlines) ⇒ rebuild + commit the relevant `plugin/workbench/...` artifact + `.srchash` in the same
  change (the standing rule, now spanning a third package).
