// Task file store — the SOURCE OF TRUTH for tasks + run-root artifacts (AC6: files survive a server
// kill; no in-memory-only state). One Markdown file per task under `.agentry/work/<run>/tasks/`, and
// the run-root `spec.md` / `plan.md` artifacts. YAML frontmatter holds the live fields (`status`,
// `lockedBy`, `version`, …); the body holds the prose — human-readable and git-diffable. Mirrors
// @agentry/memory's `MarkdownFileStore` (the frontmatter read/write pattern).
//
// Every write stamps a tool-computed `version` content-hash (AC4/AC5) — the caller never supplies it
// (it is stripped before hashing and recomputed). Reads are a pure-file `readdir` over the tasks
// directory (ADR-001 — no derived index).
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { computeVersion } from "../domain/version.js";
import type { ArtifactKind, FlowTask, TaskStore } from "../domain/ports.js";
import { runDir } from "../resolution/run-pointer.js";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

// Defensive normalization (ADR-002): a task body must never begin with its own `---…---` block —
// Flow is the SOLE frontmatter authority, so a leading block would render a second, duplicate
// frontmatter under Flow's own. Drop a block at position 0 (its keys are discarded, NOT merged)
// before render. Mirrors FRONTMATTER's leading-block shape but anchored to position 0 only: a `---`
// thematic break later in the body is untouched, a body with no leading block is byte-for-byte
// unchanged, and re-applying it is a no-op (idempotent).
const LEADING_FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;

function stripLeadingFrontmatter(body: string): string {
  return body.replace(LEADING_FRONTMATTER, "");
}

export class TaskFileStore implements TaskStore {
  constructor(private readonly cwd: string) {}

  private tasksDir(run: string): string {
    return join(runDir(this.cwd, run), "tasks");
  }

  readTask(run: string, taskNo: string): FlowTask | undefined {
    const dir = this.tasksDir(run);
    if (!existsSync(dir)) return undefined;
    const prefix = `${taskNo}-`;
    const file = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(".md"));
    if (!file) return undefined;
    return this.parseTaskFile(join(dir, file), taskNo);
  }

  listTasks(run: string): FlowTask[] {
    const dir = this.tasksDir(run);
    if (!existsSync(dir)) return [];
    const tasks: FlowTask[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".md")) continue;
      const taskNo = file.slice(0, file.indexOf("-"));
      const task = this.parseTaskFile(join(dir, file), taskNo);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  writeTask(run: string, task: FlowTask): void {
    const dir = this.tasksDir(run);
    mkdirSync(dir, { recursive: true });
    // One file per task number: drop any stale sibling (e.g. the title slug changed) before writing,
    // so a renamed task never leaves two files for the same number (mirrors MarkdownFileStore).
    const prefix = `${task.taskNo}-`;
    for (const f of readdirSync(dir)) {
      if (f.startsWith(prefix) && f.endsWith(".md")) unlinkSync(join(dir, f));
    }
    const file = `${task.taskNo}-${this.slugOf(task)}.md`;
    writeFileSync(join(dir, file), this.render(task.frontmatter, stripLeadingFrontmatter(task.body)));
  }

  readArtifact(run: string, kind: ArtifactKind): string | undefined {
    const file = join(runDir(this.cwd, run), `${kind}.md`);
    if (!existsSync(file)) return undefined;
    const m = FRONTMATTER.exec(readFileSync(file, "utf8"));
    return m ? (m[2] ?? "").trim() : readFileSync(file, "utf8");
  }

  writeArtifact(run: string, kind: ArtifactKind, body: string): void {
    const dir = runDir(this.cwd, run);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${kind}.md`), this.render({ kind }, body));
  }

  // Render frontmatter + body, stamping a tool-computed `version` (AC4/AC5). Any caller-supplied
  // `version` is dropped first, then recomputed over (body, frontmatter-sans-version) — so the
  // caller can never set the version and a body edit always yields a different one.
  private render(frontmatter: Record<string, unknown>, body: string): string {
    const { version: _dropped, ...front } = frontmatter;
    const version = computeVersion(body, front);
    const stamped = { ...front, version };
    return `---\n${stringifyYaml(stamped)}---\n\n${body}\n`;
  }

  private slugOf(task: FlowTask): string {
    const title = typeof task.frontmatter.title === "string" ? task.frontmatter.title : "";
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "");
    return slug || "task";
  }

  private parseTaskFile(path: string, taskNo: string): FlowTask | undefined {
    const m = FRONTMATTER.exec(readFileSync(path, "utf8"));
    if (!m) return undefined;
    const frontmatter = (parseYaml(m[1] ?? "") ?? {}) as Record<string, unknown>;
    return { taskNo, frontmatter, body: (m[2] ?? "").trim() };
  }
}
