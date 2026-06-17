# 09 — Repository Architecture

> **Status:** Locked (iteration 1) · **Date:** 2026-06-13 · **Scope:** how this repo is structured —
> monorepo shape, the dependency/shipping policy, the packages, the stack, and the code conventions.
> Decided *before* plugin assembly so we don't rework (the v1 lesson, applied to ourselves).
>
> Through-line: **clean, well-structured code — we dogfood our own `architecting` skill.**

---

## 0. Stance

> **The repo root *is* the Claude Code plugin; the TypeScript lives in a `packages/` workspace.**
> Everything at root is the shipped plugin payload (markdown + a hook); everything under `packages/` is
> buildable source. Maximize capability via **bundleable pure-JS libraries**; ship a single committed
> bundle with **no `node_modules`**.

---

## 1. Layout

```
agentry/                          # repo root = the Claude Code plugin
├── .claude-plugin/               # plugin.json + marketplace.json (declares components, default front door)
├── agents/                       # specialist roster (markdown)        ─┐
├── commands/                     # /agentry + /agentry:* nodes (markdown) │ SHIPPED payload
├── skills/                       # craft skills (markdown + references)   │ (already authored)
├── hooks/                        # SessionStart priming hook (dep-free)  ─┘
├── .mcp.json                     # wires @agentry/memory at the plugin root
├── packages/
│   ├── core/                     # @agentry/core   — pure types + zod contracts (no runtime deps)
│   ├── memory/                   # @agentry/memory — the MCP (ports-and-adapters; dist committed)
│   └── workbench/                # @agentry/workbench — V2 (slot reserved; built later)
├── benchmark/                    # the harness (doc 06)
├── scripts/                      # check-plugin gate, etc.
├── .docs/                        # internal design docs + anthropic refs
├── pnpm-workspace.yaml · package.json · tsconfig.base.json · biome.json
```

---

## 2. Dependency & shipping policy (the constraint that shapes everything)

A plugin installs by clone/marketplace — **no `npm install` runs for the user.** So:

| Rule | Why |
| :--- | :--- |
| **Never ship `node_modules`** | huge, fragile; not how plugins install |
| **No native/binary deps** | per-platform compiled addons can't be bundled → would force a per-OS install |
| **Pure-JS libs are welcome** | esbuild **bundles** them into one `dist/index.js` at build time |
| **`node:sqlite` for storage** | Node ≥ 24 built-in → removes the one native need (the reason for the Node-24 floor) |
| **`dist/index.js` is committed** | the one exception to gitignored build output → zero-install |

**Shipping flow:** clone → Node 24 runs `dist/index.js` → works. `node_modules` exists only on the build
machine. Use the **MCP SDK** (`@modelcontextprotocol/sdk`) and **zod** (bundled) — don't hand-roll the
protocol or validation. Keep the dep *count* small and pure-JS; otherwise, use what makes it powerful.

---

## 3. The packages

### `@agentry/core` — the contract (pure types + zod)
The **single source of truth** for every structured shape, in code, tested:
- artifact frontmatter (Spec · Plan · Task · ADR · Review · Journal) — zod schemas + inferred types
- memory records (Fact · Episode) + the enums (`MemoryType` · `Scope` · `Status` · `Shape`)
- the event-log + review-sidecar shapes (doc 10 seams)
- **No runtime dependencies.** Imported by `memory`, `benchmark`, the `check-plugin` script, and (later)
  `workbench`, so all agree on one contract. (Justified: ≥3 consumers today — past the YAGNI line.)

Where code touches the markdown artifacts (the check script, the workbench), it validates against these
schemas. The agents write the prose; core guards the structured frontmatter.

### `@agentry/memory` — the MCP (ports-and-adapters, per doc 07 §4)
```
packages/memory/src/
  domain/        # pure types + MemoryStore logic — no I/O, unit-tested
  application/   # services: write/recall/distill/consolidate/feedback
  persistence/
    file-store/  # one-file-per-memory — the SOURCE OF TRUTH
    db-index/    # node:sqlite + FTS5 derived index; rebuild(files)→DB (atomic temp+swap)
  resolution/    # two-root resolution + id origin-qualification
  tools/         # one thin adapter per tool (description + zod input + handler)
  index.ts       # stdio server: resolve roots → rebuild index → register 9 tools → connect
```
Domain is free of MCP/FS concerns; tools are thin adapters. **Logic in code, not prose.**

### `@agentry/workbench` — V2 (slot reserved)
React + Vite + TS + a thin Node service over the files (doc 10). Builds separately, runs locally — **not
on the zero-install path**, so it may use what it needs. Built when V1 runs.

---

## 4. Stack

| Concern | Choice |
| :--- | :--- |
| Package manager | **pnpm** workspaces |
| Language | **TypeScript**, `strict` everywhere |
| MCP runtime | Node ≥ 24 · `node:sqlite` + FTS5 · `@modelcontextprotocol/sdk` · `zod` |
| Bundler | **esbuild** → single committed `dist/index.js` |
| Tests | `node:test` (built-in) + `tsx` for dev — no heavy framework |
| Lint/format | **Biome** (one fast tool) |
| Workbench (V2) | React + Vite + TS |

---

## 5. Conventions (clean code — dogfood `architecting`)

- **Ports-and-adapters** in `memory`; **pure types** in `core`; **SRP-sized modules** (one reason to
  change), no god-files. Dependencies point inward (domain never imports an adapter).
- **Types are the contract, in `core`** — never duplicated across packages.
- **Right-sized** — apply structure where it earns it; no ceremony in small scripts (our own rule).
- **Dist-lockstep rule:** any `memory/src` change → rebuild + commit `dist/index.js` in the same change.
  A `scripts/check-plugin` gate verifies it (and plugin namespacing) before commit.
- **Tests:** domain + application unit-tested via `node:test`; the MCP gets a stdio integration test.

---

## 6. Cleanups (handle during assembly)

- Relocate the vendored Anthropic reference skills `.agents/skills/` → `.docs/reference/` (dev references,
  **not** shipped); update `skills-lock.json` paths accordingly. Keeps them from being confused with the
  shipped `skills/`.

---

## 7. Closed vs deferred

**Closed:** monorepo (root = plugin, `packages/` = TS workspace) · the dependency/shipping policy
(bundled pure-JS, no native, no shipped `node_modules`, committed dist) · the three packages (`core`
now, `memory` per doc 07, `workbench` V2 slot) · the stack · clean-code conventions + dist-lockstep gate.

**Deferred (next):** **plugin assembly** — `.claude-plugin/plugin.json` + marketplace manifest (incl. the
`/agentry` default front-door wiring) · `.mcp.json` · the `hooks/` priming hook · `pnpm-workspace.yaml` +
root `package.json` + `tsconfig.base.json` + `biome.json` + the `check-plugin` script · scaffold
`packages/core` + `packages/memory`. Then **implement** `@agentry/memory` and the **benchmark harness**.

---

_Signed-off (iteration 1): the repo architecture is locked — a pnpm monorepo with the plugin at root and
clean, bundleable TypeScript packages underneath; powerful libraries allowed, `node_modules` never
shipped._
