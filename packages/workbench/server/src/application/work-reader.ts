// WorkReader — the application service that folds ONE run's parsed files into the read-models the
// transport serves (task 9's `routes`/`ws` call these). PURE of HTTP/ws (ADR-001): it depends only on
// the `WorkRepository` port (the parsed files), the pure `buildGraph` (the graph), and the `Clock`
// (the deterministic `updatedAt` stamp) — no `node:http`/`ws` type crosses it, so it is unit-testable
// against a fake repository.
//
// `read(runId)` returns `{ summary, graph, docs }`:
//   - summary: the `RunSummary` for the Works list (AC2) — task tally by FLOW's closed status, the
//     agent count, the title, and the `updatedAt` stamp.
//   - graph:   the `GraphModel` via `buildGraph` (the dependency/derivation graph for an opened run).
//   - docs:    the run's parsed artifacts (spec/plan/adrs/tasks) keyed for the editor; Phase 1 ferries
//     the parsed records so task 9 can serve them without re-reading the disk.
import type { GraphModel, RunSummary } from "@agentry/workbench-shared";
import { FlowTaskStatus } from "@agentry/flow/domain/status";
import type { Clock, RunFiles, WorkRepository } from "../domain/ports.js";
import { buildGraph } from "../domain/graph.js";

// One parsed artifact as the reader hands it to the transport (frontmatter + body). The DocModel's
// version/lock fields are stamped at the transport edge (Phase 3); Phase 1 ferries the parsed record.
export interface ReaderDoc {
  id: string; // stable doc id: "spec" | "plan" | "adr-<key>" | "task-<NNN>" (mirrors buildGraph's node ids)
  frontmatter: Record<string, unknown>;
  body: string;
}

// The bundle the transport serves for one run: the list-row summary, the canvas graph, and the docs.
export interface RunRead {
  summary: RunSummary;
  graph: GraphModel;
  docs: ReaderDoc[];
}

export class WorkReader {
  constructor(
    private readonly repository: WorkRepository,
    private readonly clock: Clock,
  ) {}

  // The run ids present — a thin pass-through the Works list iterates (each row is one `read`).
  listRuns(): string[] {
    return this.repository.listRuns();
  }

  // Fold one run into its read-models, or undefined when the run is absent (task 9 turns that into a
  // 404). The graph and the summary derive from the SAME parsed `RunFiles`, so they never disagree.
  read(runId: string): RunRead | undefined {
    const files = this.repository.readRun(runId);
    if (!files) return undefined;
    return {
      summary: this.summarize(files),
      graph: buildGraph(files),
      docs: this.docsOf(files),
    };
  }

  // The Works-list row: task tally by FLOW's closed status, the agent count, the title, and the
  // `updatedAt` stamp (from the injected clock, so the read is deterministic under test).
  private summarize(files: RunFiles): RunSummary {
    return {
      run: files.run,
      title: this.titleOf(files),
      taskCounts: this.tallyTasks(files),
      agentCount: 0, // roster lives in run-state.json, not the pinned RunFiles port — see file note below
      updatedAt: this.clock.now(),
    };
  }

  // Count tasks into FLOW's closed status buckets. Every bucket starts at 0 (so a status absent from
  // the run still reports 0, not a missing key); a task whose frontmatter `status` is malformed/absent
  // falls into `todo` — the same not-started default `buildGraph` uses, kept consistent here.
  private tallyTasks(files: RunFiles): Record<FlowTaskStatus, number> {
    const counts: Record<FlowTaskStatus, number> = {
      todo: 0,
      "in-progress": 0,
      "in-review": 0,
      done: 0,
    };
    for (const task of files.tasks) {
      const parsed = FlowTaskStatus.safeParse(task.frontmatter.status);
      counts[parsed.success ? parsed.data : "todo"] += 1;
    }
    return counts;
  }

  // The run's display title: the plan's `title` frontmatter when present, else the spec's, else the
  // run id (always a non-empty string for the list row).
  private titleOf(files: RunFiles): string {
    const fromPlan = files.plan?.frontmatter.title;
    if (typeof fromPlan === "string" && fromPlan.length > 0) return fromPlan;
    const fromSpec = files.spec?.frontmatter.title;
    if (typeof fromSpec === "string" && fromSpec.length > 0) return fromSpec;
    return files.run;
  }

  // The run's docs for the editor: spec, plan, each adr, AND each task — keyed with the SAME ids
  // buildGraph mints for its nodes, so a graph click maps straight to a doc. Tasks are keyed
  // `task-<NNN>` (matching buildGraph's `taskId`), so `GET /doc/task-NNN` resolves and a task write
  // can push a fresh DocModel. The doc's lock/version are derived at the transport edge from the
  // ferried frontmatter (`toDocModel`/`lockOf`): a task whose `status: in-progress` reports locked by
  // its `lockedBy` (the SAME derivation spec/plan/adr docs already use — no second lock path here).
  private docsOf(files: RunFiles): ReaderDoc[] {
    const docs: ReaderDoc[] = [];
    if (files.spec) docs.push({ id: "spec", ...files.spec });
    if (files.plan) docs.push({ id: "plan", ...files.plan });
    files.adrs.forEach((adr, i) => {
      const id = adr.frontmatter.id;
      const key = typeof id === "string" && id.length > 0 ? id : String(i);
      docs.push({ id: `adr-${key}`, frontmatter: adr.frontmatter, body: adr.body });
    });
    for (const task of files.tasks) {
      docs.push({ id: `task-${task.taskNo}`, frontmatter: task.frontmatter, body: task.body });
    }
    return docs;
  }
}
