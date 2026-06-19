// buildGraph — the ONLY place a run's parsed files become a `GraphModel` (nodes + typed edges). PURE
// (ADR-001): plain `RunFiles` in, a plain `GraphModel` out — no fs, no ws, fully unit-testable on
// fixture data. The graph's shape mirrors the *routing* shape: the routing decision is the root, the
// spec/plan/adr/task artifacts hang off it (VISION §4). Phase 1 needs only enough graph for an opened
// run to render its Live skeleton; Phase 2 (task 12/13) consumes and visually extends this model — but
// the FULL edge-kind derivation lives here, since it is pure and testable now.
//
// The four edge kinds (the closed `GraphEdgeKind` union from the shared contract), and how each is
// derived from frontmatter:
//   - `derives`     produced-from: the routing→spec→plan→{adr,task} derivation chain. `from` is the
//                   producer, `to` the produced (root flows down to the leaves it generated).
//   - `depends-on`  a task's `deps: [n, …]` frontmatter: task → each task it depends on.
//   - `blocks`      the active inverse of a dependency: an UNFINISHED upstream task → the task it
//                   gates (depended-on, not yet `done` → dependent). A done upstream no longer blocks.
//   - `satisfies`   a task's `satisfies` frontmatter (the acceptance criteria it closes): task → spec
//                   (the spec owns the ACs), one edge per task that declares it.
import type { GraphEdge, GraphModel, GraphNode } from "@agentry/workbench-shared";
import type { FlowTask } from "@agentry/flow/domain/ports";
import { formatTaskNo } from "@agentry/flow/domain/ids";
import { FlowTaskStatus } from "@agentry/flow/domain/status";
import type { RunFiles } from "./ports.js";

// Stable node ids — one namespace per kind so a task "1" and an adr "1" never collide.
const ROOT_ID = "routing";
const SPEC_ID = "spec";
const PLAN_ID = "plan";
const taskId = (taskNo: string): string => `task-${taskNo}`;
const adrId = (key: string): string => `adr-${key}`;

// FLOW's task status when the frontmatter carries a valid one; `todo` otherwise (a freshly-sliced
// task with no status yet, or a malformed value, renders as not-started rather than throwing).
function statusOf(frontmatter: Record<string, unknown>): GraphNode["status"] {
  const parsed = FlowTaskStatus.safeParse(frontmatter.status);
  return parsed.success ? parsed.data : "todo";
}

// Normalize a frontmatter dep/ac list to string keys. Accepts an array of numbers or strings (FLOW
// task frontmatter writes `deps: [1, 3]` as numbers; `satisfies` may be `["AC3"]`); anything else
// (absent, scalar, object) yields an empty list — the field is optional, never required.
function asKeyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item === "number" && Number.isFinite(item)) keys.push(String(item));
    else if (typeof item === "string" && item.length > 0) keys.push(item);
  }
  return keys;
}

// A run's tasks indexed by their (string) task number, for dep/blocks edge resolution.
function indexTasks(tasks: FlowTask[]): Map<string, FlowTask> {
  const byNo = new Map<string, FlowTask>();
  for (const t of tasks) byNo.set(t.taskNo, t);
  return byNo;
}

// Normalize a `deps` entry to the zero-padded `NNN` task-number key the index is keyed by. FLOW writes
// `deps: [1, 3]` as bare numbers (or "6"), but task files are `006-*.md` → key "006"; so a numeric (or
// all-digit string) dep is re-padded via FLOW's own `formatTaskNo`. A non-numeric key passes through
// unchanged (it can't match a task and is dropped as a dangling dep, by design).
function depKey(raw: string): string {
  return /^\d+$/.test(raw) ? formatTaskNo(Number(raw)) : raw;
}

// The id-key of an adr file: its frontmatter `id` (e.g. "ADR-001" → "ADR-001", or a bare "001"),
// falling back to its index when absent — so two adrs never collide on an empty key.
function adrKey(frontmatter: Record<string, unknown>, index: number): string {
  const id = frontmatter.id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  if (typeof id === "string" && id.length > 0) return id;
  return String(index);
}

export function buildGraph(runFiles: RunFiles): GraphModel {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const hasRoot = runFiles.routing !== null;
  const hasSpec = runFiles.spec !== null;
  const hasPlan = runFiles.plan !== null;

  // ── Nodes ──────────────────────────────────────────────────────────────────────────────────────
  // Root: the routing decision (the graph root = the routing shape, VISION §4). Status `done` — the
  // decision is a settled fact, not an in-flight task; it just anchors the derivation chain.
  if (hasRoot && runFiles.routing) {
    nodes.push({ id: ROOT_ID, label: `routing: ${runFiles.routing.shape}`, status: "done" });
  }
  if (hasSpec) nodes.push({ id: SPEC_ID, label: "spec", status: "done" });
  if (hasPlan) nodes.push({ id: PLAN_ID, label: "plan", status: "done" });

  const adrKeys: string[] = [];
  runFiles.adrs.forEach((adr, i) => {
    const key = adrKey(adr.frontmatter, i);
    adrKeys.push(key);
    const title = typeof adr.frontmatter.title === "string" ? adr.frontmatter.title : key;
    nodes.push({ id: adrId(key), label: `adr ${key}: ${title}`, status: "done" });
  });

  for (const task of runFiles.tasks) {
    const title = typeof task.frontmatter.title === "string" ? task.frontmatter.title : task.taskNo;
    nodes.push({ id: taskId(task.taskNo), label: `${task.taskNo} ${title}`, status: statusOf(task.frontmatter) });
  }

  // ── derives edges: the routing→spec→plan→{adr,task} derivation chain (producer → produced) ───────
  if (hasRoot && hasSpec) edges.push({ from: ROOT_ID, to: SPEC_ID, kind: "derives" });
  if (hasSpec && hasPlan) edges.push({ from: SPEC_ID, to: PLAN_ID, kind: "derives" });
  // The plan produces the adrs and the tasks; when no plan exists, the spec is the nearest producer,
  // and when neither exists the routing root is — so every artifact still hangs off the chain.
  const leafProducer = hasPlan ? PLAN_ID : hasSpec ? SPEC_ID : hasRoot ? ROOT_ID : null;
  if (leafProducer) {
    for (const key of adrKeys) edges.push({ from: leafProducer, to: adrId(key), kind: "derives" });
    for (const task of runFiles.tasks) edges.push({ from: leafProducer, to: taskId(task.taskNo), kind: "derives" });
  }

  // ── depends-on + blocks edges: from each task's `deps` frontmatter ────────────────────────────────
  const byNo = indexTasks(runFiles.tasks);
  for (const task of runFiles.tasks) {
    for (const rawDep of asKeyList(task.frontmatter.deps)) {
      const dep = depKey(rawDep);
      const upstream = byNo.get(dep);
      if (!upstream) continue; // a dep on a task not in this run is dropped (no dangling edge)
      // depends-on: the dependent task points at what it needs.
      edges.push({ from: taskId(task.taskNo), to: taskId(dep), kind: "depends-on" });
      // blocks: the active inverse — an unfinished upstream is gating the dependent right now.
      if (statusOf(upstream.frontmatter) !== "done") {
        edges.push({ from: taskId(dep), to: taskId(task.taskNo), kind: "blocks" });
      }
    }
  }

  // ── satisfies edges: a task's `satisfies` frontmatter → the spec that owns the ACs ────────────────
  if (hasSpec) {
    for (const task of runFiles.tasks) {
      if (asKeyList(task.frontmatter.satisfies).length > 0) {
        edges.push({ from: taskId(task.taskNo), to: SPEC_ID, kind: "satisfies" });
      }
    }
  }

  return { nodes, edges };
}
