# CLAUDE.md — working in the Agentry repo

Agentry is an adaptive agentic layer for Claude Code (right-sized orchestration + SDLC specialists +
durable memory). **The repo root *is* the plugin**; TypeScript lives under `packages/`.

## Where things are

- `agents/` `commands/` `skills/` `hooks/` — shipped plugin payload (markdown + the dep-free primer hook)
- `.claude-plugin/plugin.json` — manifests + **inline** `mem` MCP wiring (NOT a root `.mcp.json` — that double-loads as project config and fails on `${CLAUDE_PLUGIN_ROOT}` when dogfooding)
- `packages/core` — `@agentry/core`, the typed contract · `packages/memory` — the memory MCP · `packages/workbench` — V2
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

- **Dist-lockstep** — any `packages/memory/src` change → rebuild + commit `dist/index.js` in the same change.
- **Reload-gated** — agent/command/skill/hook/MCP changes register only on reload/restart; verify live after a restart.
- **Run `node scripts/check-plugin.mjs` before every commit** (it catches namespacing + structure drift).
- **Acceptance-gated phases** (doc 12) — never advance a phase on vibes.
- **Dogfood from Phase 2 on** — build through `/agentry:go` where it helps; log friction as Evolution entries (doc 01 §5).

## Commits

End commit messages with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

When in doubt about structure, the `architecting`/`planning` skills and doc 11 govern.
