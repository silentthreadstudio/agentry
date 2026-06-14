// Derived full-text index over record bodies — node:sqlite, in-memory (rebuilt from the file store at
// startup, never persisted; the files are the truth). No DB file → nothing to gitignore, no swap.
//
// Capability-first: FTS5 gives proper ranked search, but it isn't compiled into every Node build
// (e.g. Node 22's bundled SQLite lacks it). So we try FTS5 and fall back to a plain table + token
// scan when it's absent — the server works on any node:sqlite runtime, FTS5 or not.
import { DatabaseSync } from "node:sqlite";
import type { SearchHit, TextIndex } from "../domain/ports.js";

interface DocRow {
  id: string;
  body: string;
}

/** FTS5 MATCH expression: prefix-match each word token, OR'd, so partial matches recall. */
function toMatch(query: string): string {
  return tokens(query)
    .map((t) => `${t}*`)
    .join(" OR ");
}
const tokens = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export class SqliteTextIndex implements TextIndex {
  private readonly db = new DatabaseSync(":memory:");
  private readonly fts: boolean;

  constructor() {
    this.fts = this.tryCreateFts();
    if (!this.fts) {
      this.db.exec("CREATE TABLE docs (id TEXT, body TEXT);");
      process.stderr.write("[mem] FTS5 unavailable — using LIKE fallback index\n");
    }
  }

  reset(): void {
    this.db.exec("DELETE FROM docs;");
  }

  add(id: string, body: string): void {
    // Idempotent upsert: clear any prior row for this id first, so re-adding (e.g. the recover() path)
    // never leaves a duplicate. Works for both the FTS5 and LIKE-fallback tables (neither has a UNIQUE
    // constraint, so ON CONFLICT can't fire) — and a fresh add is just a delete of zero rows.
    this.db.prepare("DELETE FROM docs WHERE id = ?").run(id);
    this.db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)").run(id, body);
  }

  search(query: string, limit: number): SearchHit[] {
    return this.fts ? this.searchFts(query, limit) : this.searchScan(query, limit);
  }

  private tryCreateFts(): boolean {
    try {
      this.db.exec("CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, body);");
      return true;
    } catch {
      return false;
    }
  }

  private searchFts(query: string, limit: number): SearchHit[] {
    const match = toMatch(query);
    if (!match) return [];
    const rows = this.db
      .prepare("SELECT id, bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?")
      .all(match, limit) as unknown as { id: string; rank: number }[];
    const n = rows.length;
    return rows.map((r, i) => ({ id: r.id, relevance: (n - i) / n }));
  }

  /** Fallback: token-overlap over a full scan. Fine for the in-memory index's modest size. */
  private searchScan(query: string, limit: number): SearchHit[] {
    const qs = tokens(query);
    if (qs.length === 0) return [];
    const rows = this.db.prepare("SELECT id, body FROM docs").all() as unknown as DocRow[];
    return rows
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
