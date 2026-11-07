// Derived full-text index over record bodies — node:sqlite, in-memory (rebuilt from the file store on every
// load, never persisted; the files are the truth). No DB file: nothing to gitignore, no swap.
//
// Capability-first: `node:sqlite` resolves through the runtime driver seam (./sqlite-driver.mjs), FTS5
// gives proper ranked search but isn't compiled into every build, and second runtimes may lack the
// module entirely. So we degrade in steps and say so on stderr: FTS5 → token-scan table → pure-JS
// token-scan (the same relevance rule through the last two — one rule, never a fork).
//
// The index is { reset(), add(id, body), search(query, limit) -> [{ id, relevance }] }, relevance 0..1.
import { openSqlite } from "./sqlite-driver.mjs";

const tokens = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** FTS5 MATCH expression: prefix-match each word token, OR'd, so partial matches recall. */
const toMatch = (query) =>
  tokens(query)
    .map((t) => `${t}*`)
    .join(" OR ");

/** Token-overlap ranking over a full scan, a query token matching as a word prefix (as FTS5 does): relevance = hits / query-token-count, filtered > 0, sorted
 * desc, limit applied last. Fine for the in-memory index's modest size. */
const rank = (rows, query, limit) => {
  const qs = tokens(query);
  if (qs.length === 0) return [];
  return rows
    .map((r) => {
      const words = tokens(r.body);
      const hits = qs.reduce((acc, t) => acc + (words.some((w) => w.startsWith(t)) ? 1 : 0), 0);
      return { id: r.id, relevance: hits / qs.length };
    })
    .filter((r) => r.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
};

export class SqliteTextIndex {
  /** Optional `driver`: a DatabaseSync class to instantiate, or `null` to force the pure-JS mode.
   * Undefined (the production path) resolves the runtime's driver. */
  #db = null;
  #fts = false;
  #rows = []; // the driver-less mode's rows — the token scan reads these

  constructor(driver) {
    const DatabaseSync = driver === undefined ? openSqlite() : driver;
    if (DatabaseSync) {
      this.#db = new DatabaseSync(":memory:");
      this.#fts = this.#tryCreateFts();
      if (!this.#fts) {
        this.#db.exec("CREATE TABLE docs (id TEXT, body TEXT);");
        process.stderr.write("[mem] FTS5 unavailable — using a token-scan fallback index\n");
      }
    } else {
      process.stderr.write("[mem] node:sqlite unavailable — using a pure-JS token-scan index\n");
    }
  }

  reset() {
    if (this.#db) this.#db.exec("DELETE FROM docs;");
    else this.#rows = [];
  }

  add(id, body) {
    if (this.#db) {
      // Idempotent upsert: clear any prior row for this id first, so re-adding an id never leaves a
      // duplicate. Works for both the FTS5 and token-scan tables (neither has a UNIQUE constraint).
      this.#db.prepare("DELETE FROM docs WHERE id = ?").run(id);
      this.#db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)").run(id, body);
    } else {
      this.#rows = this.#rows.filter((r) => r.id !== id);
      this.#rows.push({ id, body });
    }
  }

  search(query, limit) {
    if (this.#fts) return this.#searchFts(query, limit);
    if (this.#db) return rank(this.#db.prepare("SELECT id, body FROM docs").all(), query, limit);
    return rank(this.#rows, query, limit);
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
}
