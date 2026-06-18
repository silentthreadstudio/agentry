# CLAUDE.md — working in the Agentry repo

Agentry is an adaptive agentic layer for Claude Code (right-sized orchestration + SDLC specialists +
durable memory). **The shipped plugin lives in `plugin/`** (marketplace `source: "./plugin"`, so an install
copies only that dir — not the dev tree); TypeScript dev packages live under `packages/`.

## Where things are

- `plugin/` — the shipped plugin payload = `CLAUDE_PLUGIN_ROOT`:
  - `plugin/agents/ commands/ skills/ hooks/` — markdown payload + the dep-free primer hook
  - `plugin/.claude-plugin/plugin.json` — manifest + **inline** `mem` MCP wiring (`${CLAUDE_PLUGIN_ROOT}/mem/index.js`)
  - `plugin/mem/index.js` — the committed, zero-install memory MCP bundle (built from `packages/memory`)
- `.claude-plugin/marketplace.json` — the marketplace manifest (stays at repo ROOT; `source: "./plugin"`)
- `packages/core` — `@agentry/core`, the typed contract · `packages/memory` — the memory MCP (builds → `plugin/mem/`) · `packages/eval` — the self-eval harness
- `.docs/internal/01–10` — the design (read these before changing behavior); **`10` is the execution roadmap** (current: Phase 1 — implement `@agentry/memory`)

## The code bar (non-negotiable — we build the `architecting` skill; the code obeys it)

- **SRP / one concern per module. No god-files.** Split types by concern — `@agentry/core` is the
  example (`enums · memory · artifacts · events · config`, `index.ts` is a pure barrel). Never dump
  unrelated types/logic into one file.
- **Types live in `@agentry/core`** — the single source of truth. Never duplicate a contract type across packages.
- **`@agentry/memory` is ports-and-adapters** (doc 07 §4): `domain/` (pure, no I/O) → `application/` →
  `persistence/` (`file-store` = truth, `db-index` = derived) → `resolution/` → `tools/` (thin adapters).
  **Dependencies point inward**; the domain imports no infrastructure.
- **Right-sized — the counterweight.** Match structure to the work; do NOT over-engineer a small script
  (a ~100-line single-purpose gate stays one file). Over-abstraction is also an anti-pattern.
- **Capability-first agents** — no `tools:` allowlists in agent frontmatter; use whatever the user has.
- **No shipped `node_modules`** — pure-JS deps bundled by esbuild into a committed `dist`; `node:sqlite` for storage; Node ≥ 24.

## Standing process rules

- **Dist-lockstep** — any `packages/memory/src` change → rebuild + commit `plugin/mem/index.js` (+ `.srchash`) in the same change.
- **Reload-gated** — agent/command/skill/hook/MCP changes register only on reload/restart; verify live after a restart.
- **Run `node scripts/check-plugin.mjs` before every commit** (it catches namespacing + structure drift).
- **Acceptance-gated phases** (doc 12) — never advance a phase on vibes.
- **Dogfood from Phase 2 on** — build through `/agentry:go` where it helps; log friction as Evolution entries (doc 01 §5).

## Commits

End commit messages with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

When in doubt about structure, the `architecting`/`planning` skills and doc 11 govern.
