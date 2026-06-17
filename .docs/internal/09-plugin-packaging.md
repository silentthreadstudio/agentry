# 09 — Plugin Packaging: What Ships vs. What's Dev-Only

> **Status:** Decision pending (investigation done) · **Date:** 2026-06-16 · **Scope:** what a user
> actually downloads when they install the Agentry plugin, why that's a problem as the repo grows a real
> self-eval system (doc 08 §5), and the options to separate the **shipped plugin payload** from the
> **dev/eval tooling**. This is a *deliberate* restructure (it touches the plugin manifest + the inline MCP
> wiring + the dogfooding flow) — recorded here so it's done on purpose, not guessed.

---

## 1. The finding — the install pulls *everything*

`​.claude-plugin/marketplace.json` declares the plugin with **`"source": "./"`** — the plugin source *is
the repo root*. So an install copies the **entire repo**: `selfeval/`, `packages/core`, `.docs/`,
`.agentry/` history, every throwaway script — all of it ships to every user.

It is **inert** (the plugin loads only the auto-discovered `agents/ commands/ skills/ hooks/` + the `mem`
MCP from `packages/memory/dist`), so nothing *breaks*. But it is real **bloat** and it **leaks dev tooling**
(the whole self-eval, the benchmark history, internal docs) into every install. As the self-eval grows into
a persistence-first system with a `runs/` store and a UI (doc 08 §5), that leak only gets worse.

> **Open question to VERIFY before deciding:** does the plugin install copy the *whole source tree* at
> `source`, or does it respect a `files`/ignore allowlist (npm-style) or `.gitignore`? The fix differs
> sharply by the answer. Confirm against the actual install mechanism — *measure, don't assume* (the
> standing rule of this whole effort).

## 2. What the plugin actually *needs* to ship

| Ships (the payload) | Dev-only (must NOT ship) |
| :-- | :-- |
| `agents/` `commands/` `skills/` `hooks/` | `selfeval/` (the eval system, doc 08) |
| `.claude-plugin/` (manifest + inline MCP) | `packages/core` **src**, `packages/memory` **src** |
| `packages/memory/dist/` (the `mem` MCP — committed, zero-install) | `.docs/`, `.agentry/`, scripts, benchmark history |

## 3. The constraint that makes it non-trivial

`plugin.json` wires the MCP as `node ${CLAUDE_PLUGIN_ROOT}/packages/memory/dist/index.js`.
`CLAUDE_PLUGIN_ROOT` resolves to the **plugin source root** (today `./`). And CLAUDE.md's existing rule:
the MCP is wired **inline in `plugin.json`, NOT a root `.mcp.json`** (which double-loads as project config
and breaks `${CLAUDE_PLUGIN_ROOT}` when dogfooding). So **wherever the plugin root moves, the `mem` dist
must live under it**, and the inline-MCP wiring must follow.

## 4. The options

- **A — Dedicated shipped folder (recommended lean).** Move the payload (§2 left column, including the
  `mem` dist) under a single dir — `plugin/` at repo root (or `packages/plugin/` per your instinct) — and
  point marketplace `source` at it. **Only that folder ships.** Dev/eval tooling stays at repo root,
  unshipped. *Cost:* the `mem` dist must be built/copied under the plugin dir at release; the dogfooding
  `--plugin-dir` path changes; CLAUDE.md's "repo root is the plugin" line updates.
- **B — `files` allowlist (if supported).** If the install respects a `files` manifest (the §1 open
  question), keep the layout and just declare what ships. Lowest churn — *contingent on the verify*.
- **C — Eval as its own repo.** The self-eval is arguably its own product. Fully separates concerns; most
  overhead; revisit only if the eval becomes a standalone tool.

**On the eval's home specifically:** with `source: "./"`, moving `selfeval/` → `packages/eval/` *alone does
not stop it shipping* — the whole tree still copies. The eval is excluded only by **scoping the ship**
(Option A) or an allowlist (Option B). So the real lever is *scoping what ships*, not *where the eval sits*;
once scoped, the eval can live wherever is cleanest (`selfeval/` top-level or `packages/eval/`).

## 5. Recommendation

1. **Verify §1** (what the install actually copies) — one quick check, decides A vs B.
2. If it copies the whole tree (likely): **Option A** — a dedicated `plugin/` payload dir as the marketplace
   source, `mem` dist bundled under it; everything else (eval, package src, docs) stays unshipped at root.
3. Treat it as its **own spec'd task** (manifest + MCP-path + dogfooding-flow changes, verified live after a
   reload) — **not urgent** (the shipped dev code is inert today), but **do it before a public launch** so
   users get a clean, minimal install.
