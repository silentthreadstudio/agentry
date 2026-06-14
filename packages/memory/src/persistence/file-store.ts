// File store — the SOURCE OF TRUTH. One JSON file per record under each root's memory dir:
//   <root>/facts/<ulid>.json   <root>/episodes/<ulid>.json
// Origin is derived from which root a file lives in. Corrupt/conflict-marked files are skipped
// (logged), never fatal — so a bad merge can't break the rebuild.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Episode, Fact } from "@agentry/core";
import type { z } from "zod";
import { bareId, type Origin } from "../domain/id.js";
import type { FileStore, StoredEpisode, StoredFact } from "../domain/ports.js";
import { dirFor, type Roots } from "../resolution/roots.js";

export class JsonFileStore implements FileStore {
  constructor(private readonly roots: Roots) {}

  get hasProjectRoot(): boolean {
    return this.roots.project !== null;
  }

  writeFact(origin: Origin, fact: Fact): void {
    this.write(origin, "facts", fact.id, fact);
  }

  writeEpisode(origin: Origin, episode: Episode): void {
    this.write(origin, "episodes", episode.id, episode);
  }

  readFacts(): StoredFact[] {
    return this.read("facts", Fact, (origin, fact) => ({ origin, fact }));
  }

  readEpisodes(): StoredEpisode[] {
    return this.read("episodes", Episode, (origin, episode) => ({ origin, episode }));
  }

  private write(origin: Origin, kind: "facts" | "episodes", id: string, record: unknown): void {
    const dir = join(dirFor(origin, this.roots), kind);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${bareId(id)}.json`), JSON.stringify(record, null, 2));
  }

  private read<T extends { id: string }, R>(
    kind: "facts" | "episodes",
    schema: z.ZodType<T>,
    wrap: (origin: Origin, record: T) => R,
  ): R[] {
    const sources: [Origin, string][] = [["g", this.roots.global]];
    if (this.roots.project) sources.push(["p", this.roots.project]);

    const out: R[] = [];
    for (const [origin, root] of sources) {
      const dir = join(root, kind);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          out.push(wrap(origin, schema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")))));
        } catch {
          process.stderr.write(`[mem] skipped unreadable ${kind}/${file}\n`);
        }
      }
    }
    return out;
  }
}
