// File store — the SOURCE OF TRUTH. One **Markdown** file per record under each root's memory dir:
//   <root>/facts/<slug>-<ulid>.md      <root>/episodes/<slug>-<ulid>.md
// YAML frontmatter holds the fields; the body holds the prose (a fact's text / an episode's task) —
// human-readable and git-diffable (frontmatter.mjs). Origin is derived from which root a file lives in. A
// file with no frontmatter header, bad YAML or a shape mismatch is reported as a read error (and logged),
// never fatal: a merge conflict that breaks the header or YAML can't break the rebuild. There is no conflict
// detection as such: a conflict confined to the body loads as text. A write goes to a temp file renamed
// into place, so a reader sees the old record or the new one, never neither and never a part.
//
// MarkdownFileStore(roots) -> {
//   hasProjectRoot, writeFact(origin, fact), writeEpisode(origin, episode), deleteFact(origin, id),
//   deleteEpisode(origin, id), readFacts() / readEpisodes() -> { records, errors }, signature() }
// records are { origin, fact } / { origin, episode }; errors are { kind, file, reason }; the signature is
// { count, maxMtimeMs }: the freshness fingerprint of the files across both roots.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { bareId, slug } from "../domain/id.mjs";
import { Episode, Fact } from "../domain/schema.mjs";
import { dirFor } from "../resolution/roots.mjs";
import * as frontmatter from "./frontmatter.mjs";

/** `file`'s permission bits, or null when it is not there to keep them from. */
function modeOf(file) {
  try {
    return statSync(file).mode & 0o7777;
  } catch {
    return null;
  }
}

/**
 * Write `text` to `file` whole: a temp file beside it, renamed over it. The result takes the permission
 * bits of `modeFrom` (by default the file it replaces) when that exists. The temp name does not end in
 * `.md`, so reads and the signature never see it. Like `lib/fs/atomic.mjs`, except that a read-only fact
 * file is replaced rather than refused: the store has always rewritten a fact whatever its mode, and a
 * store's files are the store's to rewrite.
 */
function replaceFile(file, text, modeFrom = file) {
  const tmp = `${file}.agentry-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    const mode = modeOf(modeFrom);
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export class MarkdownFileStore {
  #roots;

  constructor(roots) {
    this.#roots = roots;
  }

  get hasProjectRoot() {
    return this.#roots.project !== null;
  }

  writeFact(origin, fact) {
    this.#write(origin, "facts", fact.id, fact, "text");
  }

  writeEpisode(origin, episode) {
    this.#write(origin, "episodes", episode.id, episode, "task");
  }

  readFacts() {
    return this.#read("facts", Fact, "text", (origin, fact) => ({ origin, fact }));
  }

  readEpisodes() {
    return this.#read("episodes", Episode, "task", (origin, episode) => ({ origin, episode }));
  }

  deleteFact(origin, id) {
    this.#remove(origin, "facts", id);
  }

  deleteEpisode(origin, id) {
    this.#remove(origin, "episodes", id);
  }

  /**
   * Stat-only freshness fingerprint: count `.md` files and fold their `mtimeMs` into a max, across
   * `facts/`+`episodes/` under BOTH roots. Same source list as the reads (global always; project when
   * present). Limitation: two writes within one `mtimeMs` tick to the same file are indistinguishable —
   * accepted: this probe only has to catch other processes' writes. The service marks its own view stale
   * after each of its writes and never relies on the probe for them. No content hashing.
   */
  signature() {
    const sources = [this.#roots.global];
    if (this.#roots.project) sources.push(this.#roots.project);

    let count = 0;
    let maxMtimeMs = 0;
    for (const root of sources) {
      for (const kind of ["facts", "episodes"]) {
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

  #remove(origin, kind, id) {
    const dir = join(dirFor(origin, this.#roots), kind);
    if (!existsSync(dir)) return;
    const suffix = `-${bareId(id)}.md`;
    for (const f of readdirSync(dir)) if (f.endsWith(suffix)) unlinkSync(join(dir, f));
  }

  /** `bodyKey` is the field rendered as the Markdown body; everything else is frontmatter. */
  #write(origin, kind, id, record, bodyKey) {
    const dir = join(dirFor(origin, this.#roots), kind);
    mkdirSync(dir, { recursive: true });

    const suffix = `-${bareId(id)}.md`;
    const { [bodyKey]: body, ...front } = record;
    const text = typeof body === "string" ? body : "";
    const file = `${slug(text || bareId(id))}${suffix}`;
    // A text change renames the file: the new one keeps the mode of the old-slug file it replaces.
    const siblings = readdirSync(dir).filter((f) => f.endsWith(suffix));
    const modeFrom = siblings.includes(file) ? file : (siblings[0] ?? file);
    replaceFile(join(dir, file), frontmatter.join(front, text), join(dir, modeFrom));

    // One file per id: only once the new file is in place, drop a sibling left under an old name
    // (text changed → slug changed).
    for (const f of readdirSync(dir))
      if (f.endsWith(suffix) && f !== file) unlinkSync(join(dir, f));
  }

  #read(kind, schema, bodyKey, wrap) {
    const sources = [["g", this.#roots.global]];
    if (this.#roots.project) sources.push(["p", this.#roots.project]);

    const records = [];
    const errors = [];
    for (const [origin, root] of sources) {
      const dir = join(root, kind);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        try {
          const { front, body } = frontmatter.split(readFileSync(join(dir, file), "utf8"));
          const parsed = schema.parse({ ...front, [bodyKey]: body });
          if (!parsed.ok) throw new Error(parsed.message);
          records.push(wrap(origin, parsed.value));
        } catch (cause) {
          // Don't swallow: record the corrupt/unreadable file so it stays legible to the caller.
          const reason = cause instanceof Error ? cause.message : String(cause);
          errors.push({ kind, file, reason });
          process.stderr.write(`[mem] skipped unreadable ${kind}/${file}\n`);
        }
      }
    }
    return { records, errors };
  }
}
