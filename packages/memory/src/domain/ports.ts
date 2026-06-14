// Ports — the seams the application depends on. Concrete adapters live in persistence/.
// Defined as interfaces so the application is unit-testable without a real FS or SQLite.
import type { Episode, Fact } from "@agentry/core";
import type { Origin } from "./id.js";

export interface StoredFact {
  origin: Origin;
  fact: Fact;
}
export interface StoredEpisode {
  origin: Origin;
  episode: Episode;
}

/**
 * A record that could not be parsed off disk (corrupt frontmatter, schema mismatch, conflict marker).
 * Plain values only — no `node:fs` types leak across the port (ADR-001 §Q1). Surfaced through the read
 * methods so a bad file is legible to the caller instead of silently swallowed (Q1 / `storage-read`).
 */
export interface ReadError {
  kind: "facts" | "episodes";
  file: string;
  reason: string;
}

/** Records parsed from disk plus any read-errors collected along the way (Q1 — errors never swallowed). */
export interface ReadResult<T> {
  records: T[];
  errors: ReadError[];
}

/** The source of truth: one JSON file per record under each root's memory dir. */
export interface FileStore {
  readonly hasProjectRoot: boolean;
  writeFact(origin: Origin, fact: Fact): void;
  writeEpisode(origin: Origin, episode: Episode): void;
  readFacts(): ReadResult<StoredFact>;
  readEpisodes(): ReadResult<StoredEpisode>;
  deleteFact(origin: Origin, id: string): void;
  deleteEpisode(origin: Origin, id: string): void;
}

export interface SearchHit {
  id: string;
  relevance: number; // 0..1, higher is better
}

/** A derived full-text index over record bodies (rebuilt from the file store at startup). */
export interface TextIndex {
  reset(): void;
  add(id: string, body: string): void;
  search(query: string, limit: number): SearchHit[];
}
