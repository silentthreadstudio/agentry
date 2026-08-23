// Backlog store — one markdown file per item at `<cwd>/.agentry/backlog/<id>.md` (doc 18 §3.1).
//
// FILES ARE TRUTH, same as every other FLOW store: kill the server and git still holds the backlog.
// The on-disk shape mirrors a task file (frontmatter + body) rather than inventing a JSON record, so an
// item is readable, greppable and diffable by hand — an item is prose with metadata, not a database row.
//
// It sits at the PROJECT root, not under `.agentry/work/<run>/`, because an item exists before any run
// does. That is the whole point of it.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { BacklogItem } from "../domain/backlog.js";
import { assertSafeSegment } from "../domain/ids.js";
import type { BacklogStore as BacklogStorePort } from "../domain/ports.js";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
// An item body must never carry its own leading `---…---`: this store is the sole frontmatter authority,
// so a leading block would render a second one underneath it (the same rule, and the same failure, as
// TaskFileStore's — a double frontmatter renders as a broken blob downstream).
const LEADING_FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;

export class FsBacklogStore implements BacklogStorePort {
  constructor(private readonly cwd: string) {}

  private dir(): string {
    return join(this.cwd, ".agentry", "backlog");
  }

  private file(id: string): string {
    assertSafeSegment(id); // the id becomes a filename — never let it escape the backlog dir
    return join(this.dir(), `${id}.md`);
  }

  read(id: string): BacklogItem | undefined {
    const file = this.file(id);
    if (!existsSync(file)) return undefined;
    try {
      return this.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined; // a corrupt/partially-written item reads as absent rather than throwing
    }
  }

  /** Every item, newest first. A file that fails to parse is SKIPPED, never fatal: one bad item must
   *  not take the whole board down. */
  list(): BacklogItem[] {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    const items: BacklogItem[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      try {
        items.push(this.parse(readFileSync(join(dir, name), "utf8")));
      } catch {
        /* skip */
      }
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  write(item: BacklogItem): void {
    const validated = BacklogItem.parse(item);
    mkdirSync(this.dir(), { recursive: true });
    writeFileSync(this.file(validated.id), this.render(validated));
  }

  remove(id: string): void {
    const file = this.file(id);
    if (existsSync(file)) unlinkSync(file);
  }

  // ── shape ────────────────────────────────────────────────────────────────────────────────────────
  // The body lives BELOW the frontmatter (not as a `body:` yaml field) so an item reads as a document:
  // `cat` it, edit it in any editor, diff it in a PR.
  private render(item: BacklogItem): string {
    const { body, ...frontmatter } = item;
    const yaml = stringifyYaml(frontmatter);
    return `---\n${yaml}---\n\n${body.replace(LEADING_FRONTMATTER, "").trim()}\n`;
  }

  private parse(text: string): BacklogItem {
    const m = FRONTMATTER.exec(text);
    if (!m || m[1] === undefined) throw new Error("backlog item has no frontmatter");
    const frontmatter = parseYaml(m[1]) as Record<string, unknown>;
    return BacklogItem.parse({ ...frontmatter, body: (m[2] ?? "").trim() });
  }
}
