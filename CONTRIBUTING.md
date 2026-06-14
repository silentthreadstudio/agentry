# Contributing to Agentry

Thanks for working on Agentry. This guide covers setup, build, test, and the standing rules a new
contributor must internalize before opening a PR. For *what* Agentry is, read the [README](./README.md);
for *why* it's built this way, read the design docs in [`.docs/internal/`](./.docs/internal/) (`01`–`10`,
where **`10` is the execution roadmap** — it's the authority on what phase the project is in).

## The one inversion to internalize first

**The repo root *is* the Claude Code plugin.** The shipped payload — `agents/`, `commands/`, `skills/`,
`hooks/`, and `.claude-plugin/` — lives at the root, not in a subdirectory. All TypeScript lives under
`packages/`. Where a change goes is driven by this: plugin behavior is markdown at the root; typed logic
is a package.

```
agentry/                  # repo root = the plugin
├── .claude-plugin/       # plugin + marketplace manifests + inline `mem` MCP wiring
├── agents/ commands/ skills/ hooks/   # shipped plugin payload (markdown + the dep-free primer hook)
├── packages/
│   ├── core/             # @agentry/core — the typed contract (single source of truth for shapes)
│   └── memory/           # @agentry/memory — the durable memory MCP
├── scripts/              # check-plugin gate
└── .docs/internal/       # the design docs (01–10)
```

## Setup

**Requires Node ≥ 24** (the memory MCP uses the built-in `node:sqlite`). The workspace uses **pnpm 9**.

```bash
corepack enable          # provides the pinned pnpm@9
pnpm install             # install workspace deps
```

## Build, test, check

All commands run from the repo root and fan out across packages (`pnpm -r`).

| Command | What it does |
| :--- | :--- |
| `pnpm build` | Build every package (`@agentry/core` via `tsc`; `@agentry/memory` bundles via esbuild). |
| `pnpm test` | Run every package's tests (`node --test`). |
| `pnpm typecheck` | Type-check all packages, no emit. |
| `pnpm lint` | `biome check .` |
| `pnpm format` | `biome format --write .` |
| `pnpm check` | **The plugin gate** — `node scripts/check-plugin.mjs`. Validates payload structure + namespacing. |

To work on a single package, `pnpm --filter @agentry/memory <script>` (e.g. `build`, `test`, `typecheck`).

## Standing rules (non-negotiable)

These are enforced in review and, where possible, by `pnpm check`.

### Code bar

- **SRP — one concern per module. No god-files.** Split types by concern; `@agentry/core` is the model
  (`enums · memory · artifacts · events · config`, `index.ts` is a pure barrel).
- **Types live in `@agentry/core`** — the single source of truth. Never duplicate a contract type across
  packages.
- **`@agentry/memory` is ports-and-adapters** (doc 07 §4): `domain/` (pure, no I/O) → `application/` →
  `persistence/` → `resolution/` → `tools/`. **Dependencies point inward**; the domain imports no
  infrastructure.
- **Right-sized.** Match structure to the work — don't over-engineer a small script (a ~100-line
  single-purpose gate stays one file). Over-abstraction is as much an anti-pattern as a god-file.
- **Capability-first agents** — no `tools:` allowlists in agent frontmatter; agents use whatever the user
  has and degrade gracefully when a tool is absent.
- **No shipped `node_modules`** — pure-JS deps are bundled by esbuild into a committed `dist`;
  `node:sqlite` for storage; Node ≥ 24.

### Process rules

- **Dist-lockstep** — any change under `packages/memory/src` → **rebuild and commit
  `packages/memory/dist/index.js` in the same change**. Skipping the rebuild ships a stale MCP that
  silently runs old code.
- **Reload-gated** — agent/command/skill/hook/MCP changes register only on plugin reload or session
  restart. "Green in code" ≠ "works live": verify live after a restart.
- **Run `pnpm check` before every commit** — it catches namespacing and structure drift.
- **Acceptance-gated phases** (doc 10) — never advance a phase on vibes; the gate must be green.
- **Read the design doc before changing behavior** — `.docs/internal/01`–`10`. Behavior changes are
  checked against their doc.

When in doubt about structure, the `architecting` and `planning` skills and doc 09 govern.

## Commits

Branch off `main` (don't commit directly to it). End every commit message with:

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

Before pushing: `pnpm check` and `pnpm test` green, and if you touched `packages/memory/src`, confirm
`dist/index.js` is rebuilt and staged.

## License

By contributing you agree your contributions are licensed under the project's [MIT](./README.md#license)
license.
