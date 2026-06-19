// FsWorkRepository — the read side over the `.agentry/work/` tree (ADR-001, the `WorkRepository` port).
// Lists the runs present and parses ONE run dir into the plain `RunFiles` the application folds into
// read-models. The ONLY fs-touching reader in this layer; the domain (`buildGraph`) never sees a file.
//
// ── Reuse, not fork (ADR-005 tier 1) ────────────────────────────────────────────────────────────────
// The on-disk shapes are FLOW's, so the parsing is FLOW's:
//   - tasks/        → FLOW's `TaskFileStore.listTasks` (its exact `FRONTMATTER` regex + `FlowTask` shape).
//   - spec/plan/adr → FLOW's `FRONTMATTER` regex + `yaml.parse` (the SAME split FLOW uses), to surface
//                     frontmatter+body as `ArtifactFile` (FLOW's `readArtifact` returns only the body,
//                     so the regex is reused directly here for the frontmatter half).
//   - run id paths  → FLOW's `workRoot`/`runDir` (the traversal-safe layout, ADR-005 §4).
//   - routing       → FLOW's `parseLogLine` over `events.jsonl` (the closed event vocabulary).
// `cwd` (the project root) is injected and threaded on every path join — no ambient cwd, mirroring
// FLOW's cwd-threaded stores.
//
// ── The two-block task file (the gotcha threaded from task 6) ────────────────────────────────────────
// A Workbench task file carries TWO frontmatter blocks: FLOW's lifecycle block (`title`/`status`/
// `version`) FIRST, then the planner's task-meta block (`phase`/`kind`/`deps`/`satisfies`) at the head
// of the body. FLOW's regex (correctly) splits only the first block as frontmatter; `buildGraph` reads
// `deps`/`satisfies`/`status`/`title` off ONE merged `frontmatter` (its fixture proves the merged shape
// is what `RunFiles.tasks[].frontmatter` must carry). So this adapter lifts the leading meta-block out
// of the body — reusing the SAME `FRONTMATTER` regex a second time, not forking the parser — and merges
// it UNDER the lifecycle fields (lifecycle wins on a key clash; `status` lives in both, FLOW's is truth).
// FLOW writes `deps: [1, 3]` as bare integers; this adapter surfaces them faithfully (no re-padding —
// `buildGraph` re-pads via FLOW's `formatTaskNo`).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ArtifactFile,
  RoutingInfo,
  RunFiles,
  WorkRepository,
} from "../domain/ports.js";
import type { FlowTask } from "@agentry/flow/domain/ports";
import { parseLogLine } from "@agentry/flow/domain/events";
import { TaskFileStore } from "@agentry/flow/persistence/task-file-store";
import { runDir, workRoot } from "@agentry/flow/resolution/run-pointer";

// FLOW's frontmatter splitter (task-file-store.ts) — the SAME pattern, reused not forked (ADR-005).
// Group 1 = the YAML between the first `---` fence; group 2 = the remaining body.
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export class FsWorkRepository implements WorkRepository {
  // Reuse FLOW's task store for tasks/ — its `listTasks` is the canonical parser for that directory.
  private readonly tasks: TaskFileStore;

  constructor(private readonly cwd: string) {
    this.tasks = new TaskFileStore(cwd);
  }

  // The run ids present under `.agentry/work/` — every immediate subdirectory. Absent root ⇒ no runs
  // (a fresh project that has never run); a non-directory entry (a stray file) is skipped.
  listRuns(): string[] {
    const root = workRoot(this.cwd);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  // Parse one run dir into `RunFiles`, or undefined when the run folder is absent. `runDir` asserts
  // `run` is a safe single segment (FLOW's traversal guard) before any fs touch.
  readRun(run: string): RunFiles | undefined {
    const dir = runDir(this.cwd, run);
    if (!existsSync(dir)) return undefined;

    return {
      run,
      routing: this.readRouting(dir),
      spec: this.readArtifactFile(join(dir, "spec.md")),
      plan: this.readArtifactFile(join(dir, "plan.md")),
      adrs: this.readAdrs(join(dir, "adr")),
      tasks: this.readTasks(run),
    };
  }

  // The routing decision that opened the run — the FIRST `routing-decision` line in `events.jsonl`
  // (the graph root, VISION §4). Read via FLOW's `parseLogLine` (the closed vocabulary), so a malformed
  // or absent line yields null rather than throwing.
  private readRouting(dir: string): RoutingInfo | null {
    const log = join(dir, "events.jsonl");
    if (!existsSync(log)) return null;
    for (const line of readFileSync(log, "utf8").split("\n")) {
      const parsed = parseLogLine(line);
      if (parsed.kind === "flow" && parsed.event.type === "routing-decision") {
        return { shape: parsed.event.shape, kind: parsed.event.kind };
      }
    }
    return null;
  }

  // A run-root artifact (spec.md / plan.md) as frontmatter+body, or null when absent. Reuses FLOW's
  // `FRONTMATTER` regex: a file with no frontmatter fence is all body (empty frontmatter), never a throw.
  private readArtifactFile(path: string): ArtifactFile | null {
    if (!existsSync(path)) return null;
    return this.parseArtifact(readFileSync(path, "utf8"));
  }

  // The adr/*.md records, id-keyed via their own frontmatter `id` downstream (buildGraph). Sorted by
  // filename (the `NNN-*.md` prefix) so adr order is stable. Absent dir ⇒ no adrs.
  private readAdrs(adrDir: string): ArtifactFile[] {
    if (!existsSync(adrDir)) return [];
    const out: ArtifactFile[] = [];
    for (const file of readdirSync(adrDir).sort()) {
      if (!file.endsWith(".md")) continue;
      out.push(this.parseArtifact(readFileSync(join(adrDir, file), "utf8")));
    }
    return out;
  }

  // The tasks/ records via FLOW's `listTasks` (its parser, its `FlowTask` shape), then the leading
  // task-meta block lifted out of each body and merged under the lifecycle frontmatter so `buildGraph`
  // sees `deps`/`satisfies` where it reads them (see the file header for why).
  private readTasks(run: string): FlowTask[] {
    return this.tasks.listTasks(run).map((task) => this.mergeTaskMeta(task));
  }

  // Lift the planner's leading `---…---` meta-block off the task body and merge its keys UNDER the
  // FLOW lifecycle frontmatter (lifecycle wins a clash — `status` is authored in both and FLOW's is
  // truth). No leading block ⇒ the task is returned unchanged.
  private mergeTaskMeta(task: FlowTask): FlowTask {
    const meta = this.leadingFrontmatter(task.body);
    if (meta === null) return task;
    return {
      taskNo: task.taskNo,
      frontmatter: { ...meta.frontmatter, ...task.frontmatter },
      body: meta.body,
    };
  }

  // Split `text` into the first frontmatter block (parsed YAML) + the remaining body, via FLOW's
  // regex. No fence ⇒ frontmatter is `{}` and the whole text is the body.
  private parseArtifact(text: string): ArtifactFile {
    const parsed = this.leadingFrontmatter(text);
    if (parsed === null) return { frontmatter: {}, body: text.trim() };
    return parsed;
  }

  // The shared split: apply FLOW's `FRONTMATTER` regex once and parse the YAML half. Returns null when
  // the text does not open with a `---` fence (so callers can distinguish "no block" from "empty block").
  private leadingFrontmatter(text: string): ArtifactFile | null {
    const m = FRONTMATTER.exec(text);
    if (!m) return null;
    const frontmatter = (parseYaml(m[1] ?? "") ?? {}) as Record<string, unknown>;
    return { frontmatter, body: (m[2] ?? "").trim() };
  }
}
