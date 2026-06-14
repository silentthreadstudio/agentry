// @agentry/memory — durable memory MCP (stdio). Ports-and-adapters; see README + doc 07.
//
// SCAFFOLD: the structure is fixed here; the 9 tools and the file-store/db-index are implemented
// in the next step (doc 07 §2/§4). Build: esbuild → dist/index.js (committed, zero-install).
// Storage: text files = source of truth; node:sqlite (Node ≥ 24) = derived index, rebuilt on start.
//
// Intended layout:
//   domain/        pure types (re-uses @agentry/core) + MemoryStore logic — no I/O, unit-tested
//   application/   services: write · recall · search · update · feedback · distill · consolidate · stats
//   persistence/
//     file-store/  one-file-per-memory (the SOURCE OF TRUTH)
//     db-index/    node:sqlite + FTS5 derived index; rebuild(files) → DB (atomic temp + swap)
//   resolution/    two-root resolution (global + project) + id origin-qualification
//   tools/         one thin adapter per MCP tool (description + zod input + handler)
//   index.ts       resolve roots → rebuild index → register 9 tools → connect stdio transport

export {}; // TODO(impl): build the stdio server per .docs/internal/07-memory-mcp.md
