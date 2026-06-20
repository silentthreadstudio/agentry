// MemReader — READ-ONLY access to the `mem` file-store (the `MemSource` port, ADR-001). Browses + searches
// facts and episodes across BOTH roots (global `~/.agentry/memory` + project `<cwd>/.agentry/memory`) for
// the Memory panel. V1 NON-GOAL: editing memory — this adapter performs ZERO writes (no write, no delete,
// no mkdir). It only reads `.md` records and returns plain `MemRecord`s; the memory store stays truth.
//
// ── The on-disk contract (verified against packages/memory/src/persistence/file-store.ts) ─────────────
//   - One Markdown file per record:  <root>/facts/<slug>-<ulid>.md  +  <root>/episodes/<slug>-<ulid>.md
//   - `---\n<yaml>\n---\n\n<body>\n`: YAML frontmatter holds the fields, the body holds the prose (a fact's
//     `text` / an episode's `task`). Same `FRONTMATTER` regex the store reads with — reused, not forked
//     (ADR-005). A corrupt / conflict-marked file is skipped, never fatal (mirrors the store's tolerance).
//   - Two roots: global is always `~/.agentry/memory`; the project root is `<cwd>/.agentry/memory` when the
//     project dir is set. We read both, tagging each record's origin by the root it came from.
//
// `@agentry/memory` ships no public type entry (no exports map) and is not a dependency of this package, so
// the records are parsed here with the store's own frontmatter regex rather than imported — the documented
// "else parse with the frontmatter regex" branch of the task.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { MemRecord, MemSource } from "../domain/ports.js";

// The store's frontmatter splitter (file-store.ts) — the SAME pattern, reused not forked (ADR-005).
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

// The body field name per record kind (the store renders these as the Markdown body): a fact's `text`, an
// episode's `task`. We re-attach the body under this key so a `MemRecord`'s fields carry the prose too.
const BODY_KEY: Record<MemKind, string> = { facts: "text", episodes: "task" };
type MemKind = "facts" | "episodes";

// A parsed mem record as the panel reads it. Extends the port's `MemRecord` (id + loose fields) with the
// browse-facet metadata the panel filters on — which kind it is and which root it came from (read-only).
export interface MemReadRecord extends MemRecord {
  kind: MemKind; // "facts" | "episodes"
  origin: "global" | "project"; // which root the file lives under
}

export class MemReader implements MemSource {
  private readonly roots: Array<{ origin: "global" | "project"; dir: string }>;

  // `cwd` (the project root) + `home` (the global root base, injectable for testing) resolve the two mem
  // roots. The project root is included only when the project mem dir exists — a project that has never
  // written memory contributes nothing rather than erroring.
  constructor(cwd: string, home: string = homedir()) {
    this.roots = [
      { origin: "global", dir: join(home, ".agentry", "memory") },
      { origin: "project", dir: join(cwd, ".agentry", "memory") },
    ];
  }

  // Every memory record across both roots (facts then episodes), each tagged with its kind + origin. A
  // corrupt/unreadable file is skipped (never fatal). The READ-ONLY browse the panel lists from.
  list(): MemReadRecord[] {
    const records: MemReadRecord[] = [];
    for (const { origin, dir } of this.roots) {
      for (const kind of ["facts", "episodes"] as const) {
        records.push(...this.readDir(origin, kind, join(dir, kind)));
      }
    }
    return records;
  }

  // One record by id, or undefined when absent. The id is the store's bare ulid (the `<slug>-<ulid>` file
  // stem's ulid half); we match on the parsed record's own `id` field, so a renamed file still resolves.
  read(id: string): MemReadRecord | undefined {
    return this.list().find((r) => r.id === id);
  }

  // A simple read-only search over both roots: a case-insensitive substring match against the record's
  // body prose and its frontmatter values (the fields a human scans for). An empty query returns all
  // records (the browse default). Search NEVER writes — it filters the in-memory `list()`.
  search(query: string): MemReadRecord[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return this.list();
    return this.list().filter((r) => recordText(r).toLowerCase().includes(needle));
  }

  // Read one kind dir under one root into records. Absent dir ⇒ no records. Each `.md` file is split with
  // the store's frontmatter regex; a file with no fence, or one whose YAML fails to parse, is skipped (the
  // store's "corrupt files are skipped, never fatal" tolerance).
  private readDir(origin: "global" | "project", kind: MemKind, dir: string): MemReadRecord[] {
    if (!existsSync(dir)) return [];
    const records: MemReadRecord[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".md")) continue;
      const record = this.parseRecord(origin, kind, join(dir, file));
      if (record !== null) records.push(record);
    }
    return records;
  }

  // Parse one record file into a `MemReadRecord`, or null when it can't be read as a fenced record. The
  // frontmatter fields are kept loose (the store owns the field contract); the body prose is re-attached
  // under the kind's body key. The `id` is the record's own frontmatter `id` (the store always writes it);
  // a record with no `id` falls back to the file stem so it still has a stable key.
  private parseRecord(origin: "global" | "project", kind: MemKind, file: string): MemReadRecord | null {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const m = FRONTMATTER.exec(text);
    if (!m) return null;
    let front: Record<string, unknown>;
    try {
      front = (parseYaml(m[1] ?? "") ?? {}) as Record<string, unknown>;
    } catch {
      return null; // a conflict-marked / malformed YAML file is skipped, never fatal
    }
    const body = (m[2] ?? "").trim();
    const fields: Record<string, unknown> = { ...front, [BODY_KEY[kind]]: body };
    const id = typeof front.id === "string" && front.id.length > 0 ? front.id : stemOf(file);
    return { id, fields, kind, origin };
  }
}

// The concatenated searchable text of a record: its body prose plus every string/number frontmatter value.
function recordText(record: MemReadRecord): string {
  const parts: string[] = [];
  for (const value of Object.values(record.fields)) {
    if (typeof value === "string") parts.push(value);
    else if (typeof value === "number") parts.push(String(value));
  }
  return parts.join("\n");
}

// The `<slug>-<ulid>` file stem (the filename without its `.md` extension) — the id fallback when a record
// carries no `id` field.
function stemOf(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -".md".length) : name;
}
