# @agentry/memory

Agentry's durable memory MCP — the moat. A local **stdio** MCP server (TypeScript + `node:sqlite`)
bundled into the plugin and launched via the plugin-root `.mcp.json` as the `mem` server.

**Zero-install:** ships as a single self-contained `dist/index.js` (deps bundled by esbuild;
`node:sqlite` is built into Node ≥ 24). A fresh clone runs it with just Node — no `npm install`, no
native build. `dist/index.js` is the one **committed** build artifact (doc 09).

## Storage (doc 02 §6 / doc 07 §0)

**Text files are the source of truth; the SQLite DB is a disposable, gitignored index** rebuilt from
them. One file per memory, origin-qualified ULID ids, supersede-not-mutate, two roots (global
`~/.agentry` + project `.agentry/`). A write is atomic *inline* (file + row); out-of-band changes
(git pull/merge) are absorbed by an atomic rebuild-on-start.

## Tools (doc 07 §2)

`memory_write` · `episode_write` · `memory_recall` · `memory_search` · `memory_update` ·
`memory_feedback` · `memory_distill` · `memory_consolidate` · `memory_stats`

## Layout (ports-and-adapters)

```
src/
  domain/        pure types + MemoryStore logic (no I/O, unit-tested)
  application/   services per tool
  persistence/   file-store (truth) + db-index (node:sqlite/FTS5, derived)
  resolution/    two-root resolution + id origin-qualification
  tools/         thin MCP adapters
  index.ts       stdio server wiring
```

## Develop

```bash
pnpm --filter @agentry/memory build      # esbuild → dist/index.js (commit it — dist-lockstep, doc 09)
pnpm --filter @agentry/memory test       # node:test — unit + stdio integration
pnpm --filter @agentry/memory typecheck
```

**Dist-lockstep rule:** any change under `src/` requires rebuilding and committing `dist/index.js` in
the same change. `node scripts/check-plugin.mjs` flags drift.
