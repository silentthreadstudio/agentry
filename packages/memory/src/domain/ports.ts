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

/** The source of truth: one JSON file per record under each root's memory dir. */
export interface FileStore {
  readonly hasProjectRoot: boolean;
  writeFact(origin: Origin, fact: Fact): void;
  writeEpisode(origin: Origin, episode: Episode): void;
  readFacts(): StoredFact[];
  readEpisodes(): StoredEpisode[];
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
