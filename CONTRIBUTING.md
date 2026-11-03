# Contributing to Agentry

Thanks for your interest. Agentry is built to a deliberate bar — the same discipline it asks of the agents
it runs. This guide gets you set up and explains what a change is held to. For *what* Agentry is, read the
[README](./README.md).

## Repository shape

- **`plugin/`** — the shipped plugin (`CLAUDE_PLUGIN_ROOT`). `agents/ commands/ skills/`, the manifest
  in `.claude-plugin/plugin.json`, and the committed memory MCP bundle `mem/index.js`. A marketplace install
  copies **only this directory** (`source: "./plugin"`) — not the dev tree.
- **`packages/`** — dev-only TypeScript, a pnpm workspace:
  - `core` — `@agentry/core`, the single source of truth for contract types.
  - `memory` — `@agentry/memory`, the durable memory MCP (builds into `plugin/mem/`).
  - `web` — the docs site.
  - `eval` — the self-evaluation harness (routing · decision-quality · memory-moat · reporter).
- `.claude-plugin/marketplace.json` — the marketplace manifest (stays at the repo root).
- `scripts/check-plugin.mjs` — the structure + dist-lockstep gate.

## Setup

Requires **Node ≥ 24** (the memory MCP uses the built-in `node:sqlite`) and **pnpm** (via Corepack — the
version is pinned in the root `package.json` `packageManager` field).

```bash
corepack enable
pnpm install
pnpm -r build         # every package; the shipped bundles land in plugin/
pnpm -r typecheck
pnpm -r test          # every package — all offline, no API spend
pnpm lint             # biome: lint, format, import order
node scripts/check-plugin.mjs   # the gate (also `pnpm check`)
```

Work on one package with `pnpm --filter @agentry/memory <script>`.

## The code bar (non-negotiable)

- **SRP / one concern per module. No god-files.** Types split by concern; `@agentry/core` is the example
  (`enums · memory · artifacts · events · config`, `index.ts` a pure barrel).
- **Contract types live in `@agentry/core`** — never duplicated across packages.
- **`@agentry/memory` is ports-and-adapters** — `domain/` (pure, no I/O) → `application/` → `persistence/`
  (file-store = truth, db-index = derived) → `resolution/` → `tools/`. Dependencies point inward.
- **Right-sized.** Match structure to the work; don't over-engineer a small script, don't under-structure a
  real subsystem.
- **Capability-first agents** — no `tools:` allowlists in agent frontmatter.
- **No shipped `node_modules`** — the memory MCP is an esbuild bundle committed at `plugin/mem/index.js`.

## Standing rules (CI enforces these)

- **Run `node scripts/check-plugin.mjs` (`pnpm check`) before every commit** — it catches namespacing +
  structure drift.
- **Dist-lockstep** — any change to the bundled package's sources (`memory`) ⇒ `pnpm build`
  and commit the updated `plugin/` bundle (+ its `.srchash`) in the **same** change. The gate verifies it by
  content hash.
- **Reload-gated** — agent/command/skill/MCP changes register only on a Claude Code reload/restart;
  verify live after a restart.
- All packages must `typecheck`, `test` and `lint` green; CI runs the gate and the packages on every push/PR.

## Commits

- [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, imperative, lowercase, no
  trailing period, at most 72 characters. One logical change per commit; a body only when the why isn't obvious.
- Commits and PRs carry their human author only: no AI co-author trailers, session links or "Generated with" lines.
- Never commit secrets, `node_modules`, local agent state (`.agentry/`) or agent instruction files (`CLAUDE.md`,
  `CLAUDE.local.md`, `.claude/`).

## Pull requests

- Branch from `main`; keep the change focused.
- Describe **what** changed and **why**; link any issue. The PR template prompts for this.
- Make sure CI is green (gate, typecheck, tests, lint).

## Reporting bugs / requesting features

Use the issue templates. For anything security-sensitive see [`SECURITY.md`](./SECURITY.md) — please do
**not** open a public issue for vulnerabilities.

## License

By contributing you agree your contributions are licensed under the project's [MIT](./LICENSE) license.
