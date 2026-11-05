# @agentry/memory

Agentry's durable memory: a local **stdio** MCP server (TypeScript + `node:sqlite`) that the plugin
starts as its `mem` server. The wiring is inline in `plugin/.claude-plugin/plugin.json`:

```json
"mcpServers": { "mem": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/mem/index.js"] } }
```

**Zero-install.** The server ships as one self-contained ESM bundle, `plugin/mem/index.js`, built by
esbuild with every dependency inlined except `node:sqlite`, which is built into Node ≥ 24. A plugin
install runs it with just Node: no `npm install`, no native build. The bundle and its stamp
`plugin/mem/.srchash` are committed; this package's `dist/` is not used.

## Storage

**Markdown files are the source of truth.** Each record is one file with YAML frontmatter for its
fields and a body for its prose (a fact's text, an episode's task):

```
<root>/facts/<slug>-<ulid>.md
<root>/episodes/<slug>-<ulid>.md
```

- **Two roots.** Global: `~/.agentry/memory` (base dir overridable with `AGENTRY_GLOBAL_DIR`).
  Project: `<dir>/.agentry/memory`, where `<dir>` is `CLAUDE_PROJECT_DIR`, else
  `AGENTRY_PROJECT_DIR`; there is no project root when neither is set. A fact with scope `repo` goes to the project root when there is one; `user` and
  `global` facts always go to the global root.
- **Ids** are origin-qualified ULIDs: `p:01J…` lives in the project root, `g:01J…` in the global one.
  The slug only makes the file name readable; the ULID is the identity.
- **Writes** go to a temp file beside the target, renamed into place; a sibling left under an old
  slug is removed only after that. A reader sees the old record or the new one, never neither and
  never a part. Each write is atomic per file, not across files.
- **Supersede, don't mutate.** A replacing fact marks the old one `superseded`; recall never returns
  it. Facts that keep being recalled without being used self-archive, and `memory_recover` brings
  one back.
- **Unreadable files** (no frontmatter header, bad YAML or a schema mismatch) are left out of the
  store and reported in `memory_stats` as `readErrors`. One bad file never breaks the load. That
  covers a merge conflict that breaks the header or YAML; there is no conflict detection as such, so a
  conflict confined to the body loads as text.

**The text index is derived and in memory.** `node:sqlite` holds an FTS5 table in `:memory:`, or a
token-scan table on a runtime whose SQLite lacks FTS5. No database file exists. The index is built
by a full load of both roots at startup, and rebuilt by the same full load whenever it may be stale:

- before each search, recall or stats, the server compares a cheap stat-only fingerprint of the
  files (count and newest mtime) with the one it last loaded, which catches another process's
  writes;
- the server's own writes mark the loaded view stale, so the next read reloads it (the index is never
  patched in place);
- `memory_resync` forces a reload.

## Tools

| Tool | What it does |
|---|---|
| `memory_write` | Capture a fact. Reinforces a near-duplicate instead of copying it; `supersedes` retires the old fact. |
| `memory_recall` | A few ranked, active facts for a query; `mode: "prime"` returns the session warm set and recent episodes. |
| `memory_search` | Broader full-text search with snippets. |
| `memory_update` | Patch a fact. `supersedes` retires the target as on `memory_write`, and may not name the fact itself. A scope that would move the fact to the other root is refused. So is setting a non-active fact active: use `memory_recover` for an archived one; a superseded one stays superseded. |
| `memory_feedback` | Usefulness signal after a run: used facts are boosted, recalled-but-unused ones decay toward archive. |
| `memory_forget` | Delete a fact or episode from the store and disk. |
| `memory_recover` | Restore an archived fact to active. |
| `memory_resync` | Force a reload from the files and report the counts before and after. |
| `episode_write` | Record an episode (task, shape, outcome, lesson, used memories). |
| `memory_stats` | Counts by status and type, undistilled-episode debt, and `readErrors`. |
| `memory_distill` | List undistilled episodes with draft facts, or stamp episodes distilled. |
| `memory_consolidate` | Cluster recurring facts and propose skills. It never installs one. |

A failure is a typed error envelope (`code`, `what`, `why`, `fix`) whose closed `code` set is defined
in `@agentry/core`. An id that names nothing is `not-found`; a call the record's state does not allow
is `invalid-state`.

## Layout (ports and adapters, dependencies point inward)

```
src/
  domain/        pure: ids (id.ts), dedup, ranking, and the ports (FileStore, TextIndex). No I/O.
  application/   memory-service.ts (the one service: facts, episodes, recall, freshness) and
                 flows.ts (distill and consolidate analyses)
  persistence/   file-store.ts (Markdown files, the truth) and db-index.ts (the derived index)
  resolution/    roots.ts (the two roots and which one a scope writes to)
  tools/         thin MCP adapters: input schemas, outcome → envelope (errors.ts)
  index.ts       stdio server wiring
```

## Develop

```bash
pnpm --filter @agentry/memory build      # esbuild → plugin/mem/index.js + plugin/mem/.srchash
pnpm --filter @agentry/memory test       # node:test, against temp-dir stores
pnpm --filter @agentry/memory typecheck
```

**Dist-lockstep:** any change under `src/` (or in `@agentry/core`, which the bundle inlines) means
rebuilding and committing `plugin/mem/index.js` and `plugin/mem/.srchash` in the same change.
`node scripts/check-plugin.mjs` flags a bundle that is out of step with its source.
