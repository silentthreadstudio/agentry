// Derived full-text index over record bodies — node:sqlite FTS5, in-memory (rebuilt at startup
// from the file store, never persisted; the files are the truth). No DB file → nothing to gitignore,
// no atomic-swap dance. A fresh session rebuilds from files.
import { DatabaseSync } from "node:sqlite";
import type { SearchHit, TextIndex } from "../domain/ports.js";

interface RankRow {
  id: string;
  rank: number;
}

/** Build an FTS5 MATCH expression: prefix-match each word token, OR'd, so partial matches recall. */
function toMatch(query: string): string {
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return tokens.map((t) => `${t}*`).join(" OR ");
}

export class SqliteTextIndex implements TextIndex {
  private readonly db = new DatabaseSync(":memory:");

  constructor() {
    this.db.exec("CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, body);");
  }

  reset(): void {
    this.db.exec("DELETE FROM docs;");
  }

  add(id: string, body: string): void {
    this.db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)").run(id, body);
  }

  search(query: string, limit: number): SearchHit[] {
    const match = toMatch(query);
    if (!match) return [];
    const rows = this.db
      .prepare("SELECT id, bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?")
      .all(match, limit) as unknown as RankRow[];
    // bm25 orders best-first; map position → relevance in (0..1] (magnitude tuned later via benchmark).
    const n = rows.length;
    return rows.map((r, i) => ({ id: r.id, relevance: (n - i) / n }));
  }
}
