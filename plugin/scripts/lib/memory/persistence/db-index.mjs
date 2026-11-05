// Derived full-text index over record bodies — node:sqlite, in-memory (rebuilt from the file store on every
// load, never persisted; the files are the truth). No DB file: nothing to gitignore, no swap.
//
// Capability-first: FTS5 gives proper ranked search, but it isn't compiled into every Node build. So we try
// FTS5 and fall back to a plain table + token scan when it's absent: the index works on any node:sqlite
// runtime, FTS5 or not.
//
// The index is { reset(), add(id, body), search(query, limit) -> [{ id, relevance }] }, relevance 0..1.
import { DatabaseSync } from "node:sqlite";

const tokens = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** FTS5 MATCH expression: prefix-match each word token, OR'd, so partial matches recall. */
const toMatch = (query) =>
  tokens(query)
    .map((t) => `${t}*`)
    .join(" OR ");

export class SqliteTextIndex {
  #db = new DatabaseSync(":memory:");
  #fts;

  constructor() {
    this.#fts = this.#tryCreateFts();
    if (!this.#fts) {
      this.#db.exec("CREATE TABLE docs (id TEXT, body TEXT);");
      process.stderr.write("[mem] FTS5 unavailable — using a token-scan fallback index\n");
    }
  }

  reset() {
    this.#db.exec("DELETE FROM docs;");
  }

  add(id, body) {
    // Idempotent upsert: clear any prior row for this id first, so re-adding an id never leaves a
    // duplicate. Works for both the FTS5 and token-scan tables (neither has a UNIQUE constraint).
    this.#db.prepare("DELETE FROM docs WHERE id = ?").run(id);
    this.#db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)").run(id, body);
  }

  search(query, limit) {
    return this.#fts ? this.#searchFts(query, limit) : this.#searchScan(query, limit);
  }

  #tryCreateFts() {
    try {
      this.#db.exec("CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, body);");
      return true;
    } catch {
      return false;
    }
  }

  #searchFts(query, limit) {
    const match = toMatch(query);
    if (!match) return [];
    const rows = this.#db
      .prepare("SELECT id, bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?")
      .all(match, limit);
    const n = rows.length;
    return rows.map((r, i) => ({ id: r.id, relevance: (n - i) / n }));
  }

  /** Fallback: token-overlap over a full scan. Fine for the in-memory index's modest size. */
  #searchScan(query, limit) {
    const qs = tokens(query);
    if (qs.length === 0) return [];
    return this.#db
      .prepare("SELECT id, body FROM docs")
      .all()
      .map((r) => {
        const body = r.body.toLowerCase();
        const hits = qs.reduce((acc, t) => acc + (body.includes(t) ? 1 : 0), 0);
        return { id: r.id, relevance: hits / qs.length };
      })
      .filter((r) => r.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  }
}
