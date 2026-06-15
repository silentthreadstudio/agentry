// File store — the SOURCE OF TRUTH. One **Markdown** file per record under each root's memory dir:
//   <root>/facts/<slug>-<ulid>.md      <root>/episodes/<slug>-<ulid>.md
// YAML frontmatter holds the fields; the body holds the prose (a fact's text / an episode's task) —
// human-readable and git-diffable. Origin is derived from which root a file lives in. Corrupt/
// conflict-marked files are skipped (logged), never fatal — a bad merge can't break the rebuild.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Episode, Fact } from "@agentry/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { z } from "zod";
import { bareId, slug, type Origin } from "../domain/id.js";
import type {
  FileStore,
  ReadError,
  ReadResult,
  StoreSignature,
  StoredEpisode,
  StoredFact,
} from "../domain/ports.js";
import { dirFor, type Roots } from "../resolution/roots.js";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export class MarkdownFileStore implements FileStore {
  constructor(private readonly roots: Roots) {}

  get hasProjectRoot(): boolean {
    return this.roots.project !== null;
  }

  writeFact(origin: Origin, fact: Fact): void {
    this.write(origin, "facts", fact.id, fact, "text");
  }

  writeEpisode(origin: Origin, episode: Episode): void {
    this.write(origin, "episodes", episode.id, episode, "task");
  }

  readFacts(): ReadResult<StoredFact> {
    return this.read("facts", Fact, "text", (origin, fact) => ({ origin, fact }));
  }

  readEpisodes(): ReadResult<StoredEpisode> {
    return this.read("episodes", Episode, "task", (origin, episode) => ({ origin, episode }));
  }

  deleteFact(origin: Origin, id: string): void {
    this.remove(origin, "facts", id);
  }

  deleteEpisode(origin: Origin, id: string): void {
    this.remove(origin, "episodes", id);
  }

  /**
   * Stat-only freshness fingerprint (ADR-001): count `.md` files and fold their `mtimeMs` into a max,
   * across `facts/`+`episodes/` under BOTH roots. Same source list as the reads (global always; project
   * when present). Limitation: two writes within one `mtimeMs` tick to the same file are indistinguishable
   * — accepted, the out-of-band writer is a separate process (>1ms round-trip) and the in-process writer
   * updates the map directly (it never relies on this probe). No content hashing (ADR-001 alt #3).
   */
  signature(): StoreSignature {
    const sources: string[] = [this.roots.global];
    if (this.roots.project) sources.push(this.roots.project);

    let count = 0;
    let maxMtimeMs = 0;
    for (const root of sources) {
      for (const kind of ["facts", "episodes"] as const) {
        const dir = join(root, kind);
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".md")) continue;
          try {
            const { mtimeMs } = statSync(join(dir, file));
            count++;
            if (mtimeMs > maxMtimeMs) maxMtimeMs = mtimeMs;
          } catch {
            // Skip on vanish: a cross-process writer may delete a file between readdir and stat;
            // a file that no longer exists simply doesn't contribute to count/mtime (mirrors the read path).
          }
        }
      }
    }
    return { count, maxMtimeMs };
  }

  private remove(origin: Origin, kind: "facts" | "episodes", id: string): void {
    const dir = join(dirFor(origin, this.roots), kind);
    if (!existsSync(dir)) return;
    const suffix = `-${bareId(id)}.md`;
    for (const f of readdirSync(dir)) if (f.endsWith(suffix)) unlinkSync(join(dir, f));
  }

  /** `bodyKey` is the field rendered as the Markdown body; everything else is frontmatter. */
  private write(
    origin: Origin,
    kind: "facts" | "episodes",
    id: string,
    record: Record<string, unknown>,
    bodyKey: string,
  ): void {
    const dir = join(dirFor(origin, this.roots), kind);
    mkdirSync(dir, { recursive: true });

    // One file per id: drop any stale sibling (e.g. text changed → slug changed) before writing.
    const suffix = `-${bareId(id)}.md`;
    for (const f of readdirSync(dir)) if (f.endsWith(suffix)) unlinkSync(join(dir, f));

    const { [bodyKey]: body, ...front } = record;
    const text = typeof body === "string" ? body : "";
    const file = `${slug(text || bareId(id))}${suffix}`;
    writeFileSync(join(dir, file), `---\n${stringifyYaml(front)}---\n\n${text}\n`);
  }

  private read<S extends z.ZodType<{ id: string }, z.ZodTypeDef, unknown>, R>(
    kind: "facts" | "episodes",
    schema: S,
    bodyKey: string,
    wrap: (origin: Origin, record: z.output<S>) => R,
  ): ReadResult<R> {
    const sources: [Origin, string][] = [["g", this.roots.global]];
    if (this.roots.project) sources.push(["p", this.roots.project]);

    const records: R[] = [];
    const errors: ReadError[] = [];
    for (const [origin, root] of sources) {
      const dir = join(root, kind);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        try {
          const m = FRONTMATTER.exec(readFileSync(join(dir, file), "utf8"));
          if (!m) continue;
          const front = parseYaml(m[1] ?? "") as Record<string, unknown>;
          records.push(wrap(origin, schema.parse({ ...front, [bodyKey]: (m[2] ?? "").trim() })));
        } catch (cause) {
          // Don't swallow: record the corrupt/unreadable file so it stays legible to the caller (Q1).
          const reason = cause instanceof Error ? cause.message : String(cause);
          errors.push({ kind, file, reason });
          process.stderr.write(`[mem] skipped unreadable ${kind}/${file}\n`);
        }
      }
    }
    return { records, errors };
  }
}
