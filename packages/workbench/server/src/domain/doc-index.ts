// buildDocIndex — the ONLY place a run's parsed files become the ORDERED LIST OF DOCUMENTS the run view
// opens. PURE (ADR-001): plain `RunFiles` in, a plain array out — no fs, no ws, fully unit-testable on
// fixture data.
//
// This is what remains of `buildGraph`. That function produced nodes AND four kinds of typed edge
// (`derives` / `depends-on` / `blocks` / `satisfies`) for the React Flow canvas — and when the canvas
// was deleted in v2 (doc 19 X1), nothing read the edges. They kept being derived on every read of every
// run, and the shared contract kept carrying `GraphModel`/`GraphEdge`/`GraphEdgeKind` for a view that no
// longer existed. A model nobody reads is not documentation, it is drift waiting to happen: the honest
// shape is the one the UI actually consumes.
//
// (The dependency relationships themselves are NOT lost — they are read from FLOW's own task
// frontmatter where the board needs them, e.g. the blocked-by chips.)
import type { RunDoc } from "@agentry/workbench-shared";
import { FlowTaskStatus } from "@agentry/flow/domain/status";
import type { RunFiles } from "./ports.js";

// Stable doc ids — one namespace per kind so a task "1" and an adr "1" never collide. These are the same
// ids `GET /api/work/:id/doc/:docId` resolves, so an entry here maps straight to a fetchable document.
const SPEC_ID = "spec";
const PLAN_ID = "plan";
const adrId = (key: string): string => `adr-${key}`;

// FLOW's task status when the frontmatter carries a valid one; `todo` otherwise (a freshly-sliced task
// with no status yet, or a malformed value, reads as not-started rather than throwing).
function statusOf(frontmatter: Record<string, unknown>): RunDoc["status"] {
  const parsed = FlowTaskStatus.safeParse(frontmatter.status);
  return parsed.success ? parsed.data : "todo";
}

// The id-key of an adr file: its frontmatter `id` (e.g. "ADR-001", or a bare "001"), falling back to its
// index when absent — so two adrs never collide on an empty key.
function adrKey(frontmatter: Record<string, unknown>, index: number): string {
  const id = frontmatter.id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  if (typeof id === "string" && id.length > 0) return id;
  return String(index);
}

/** A run's documents in READING ORDER: spec, plan, ADRs, then tasks by number. The order is fixed here
 *  rather than in the client so every consumer opens the same document first — the spec, which is what
 *  the run is *for*. */
export function buildDocIndex(runFiles: RunFiles): RunDoc[] {
  const docs: RunDoc[] = [];

  // The spec and plan are artifacts, not tasks — they have no lifecycle of their own, so they read as
  // settled (`done`) once written. Their real state is the run's, which the board already shows.
  if (runFiles.spec !== null) docs.push({ id: SPEC_ID, label: "spec", status: "done" });
  if (runFiles.plan !== null) docs.push({ id: PLAN_ID, label: "plan", status: "done" });

  runFiles.adrs.forEach((adr, i) => {
    const key = adrKey(adr.frontmatter, i);
    const title = typeof adr.frontmatter.title === "string" ? adr.frontmatter.title : key;
    docs.push({ id: adrId(key), label: `adr ${key}: ${title}`, status: "done" });
  });

  for (const task of runFiles.tasks) {
    const title = typeof task.frontmatter.title === "string" ? task.frontmatter.title : task.taskNo;
    docs.push({
      id: `task-${task.taskNo}`,
      label: `${task.taskNo} ${title}`,
      status: statusOf(task.frontmatter),
    });
  }

  return docs;
}
