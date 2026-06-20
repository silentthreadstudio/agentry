// The Agentry Workbench read-model contract (ADR-005 tier 2) — the transport types the server's
// aggregator (`application/`, `transport/`) produces and the web client's `api/` consumes. Owned by
// exactly ONE task so both halves import one non-drifting definition (plan §6). These are LOCAL
// transport shapes: they live here, NOT in `@agentry/core` (which is for genuinely cross-package
// contracts — ADR-005 rejects polluting it with UI/transport concerns).
//
// ── Leaning on @agentry/flow, not redefining it (ADR-005 tier 1) ──────────────────────────────────
// Where a field carries a FLOW on-disk shape — a task status, an agent state, an event, a review
// comment — we IMPORT FLOW's closed `domain/` union rather than re-declaring it. A FLOW schema change
// then ripples here as a compile error, not a silent runtime desync (the documented desync gotcha).
// NOTE on the import paths: @agentry/flow ships no public type entry yet (no main/types/exports; it
// builds only to a bundled MCP), so these specifiers are bridged to FLOW's domain source by a `paths`
// shim in this package's tsconfig.json — see that file's header. When @agentry/flow publishes a real
// type entry, swap these three specifiers for the public one and delete the shim.
import type { FlowEvent } from "@agentry/flow/domain/events";
import type { ReviewComment, ReviewDecision } from "@agentry/flow/domain/review";
import type { AgentState, FlowTaskStatus } from "@agentry/flow/domain/status";

// ── Run summary ───────────────────────────────────────────────────────────────────────────────────
// The top-of-app glance at a run: which run, its task tally by lifecycle status, and how many agents
// are live. `taskCounts` is keyed by FLOW's closed task-status union, so a new status anywhere in FLOW
// surfaces as a compile error here, not a forgotten bucket.
export interface RunSummary {
  run: string; // the run id (the .agentry/work/<run>/ folder name)
  title: string; // human-readable run title (the goal slug, expanded)
  shape?: string; // routing shape: "one-shot" | "spec-first" | "decompose+verify"
  kind?: string; // routing/spec kind: "feature" | "bug" | "refactor" | ...
  summary?: string; // a one-line resume of the run's intent (extracted from the spec/plan body)
  taskCounts: Record<FlowTaskStatus, number>;
  agentCount: number; // agents currently in the run roster
  updatedAt: string; // ISO timestamp of the most recent change observed by the aggregator
}

// ── Graph model ───────────────────────────────────────────────────────────────────────────────────
// The dependency/relationship graph the React Flow canvas renders. A pure read-model: nodes are tasks
// (carrying FLOW's closed task status), edges are the four typed relationships between them.

// The relationship an edge expresses. `derives` = produced-from (spec→plan→task); `depends-on` = the
// task dep order; `blocks` = the inverse a blocked task draws; `satisfies` = a task closing an
// acceptance criterion. A closed union — a fifth kind is a compile error, not a silent render.
export type GraphEdgeKind = "derives" | "depends-on" | "blocks" | "satisfies";

export interface GraphNode {
  id: string; // stable node id (the task number / artifact key)
  label: string; // display label
  status: FlowTaskStatus; // FLOW's closed lifecycle status (imported, not redeclared)
}

export interface GraphEdge {
  from: string; // source node id
  to: string; // target node id
  kind: GraphEdgeKind;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── Document model ────────────────────────────────────────────────────────────────────────────────
// One markdown artifact (a spec / plan / task file) shipped to the editor: its parsed frontmatter, its
// body prose, the FLOW content-hash `version` (the optimistic-concurrency token — ADR-006), and the
// current edit `lock` if one is held. `frontmatter` is loose (`unknown` values) — the server owns each
// file's field contract; this read-model only ferries the parsed record, it does not re-type it.
export interface DocLock {
  by: string; // the holder of the lock (agent/role id)
  acquiredAt: string; // ISO timestamp the lock was taken
}

export interface DocModel {
  frontmatter: Record<string, unknown>;
  body: string;
  version: string; // FLOW's computeVersion() content hash — derived, never client-supplied (ADR-006)
  lock: DocLock | null; // the held edit lock, or null when the doc is free
}

// ── Gate inbox item ───────────────────────────────────────────────────────────────────────────────
// One pending review/gate decision in the inbox: which gate, the document it annotates, and the FLOW
// review comments on it (imported from FLOW's review sidecar shape, not redeclared). `decision` carries
// FLOW's closed review verdict for the gate as a whole when one has been reached.
export interface GateItem {
  gate: string; // the gate key (spec / plan / ship, per FLOW)
  docId: string; // the document this gate decides on
  comments: ReviewComment[]; // the review sidecar comments (FLOW's closed shape)
  decision: ReviewDecision | null; // the verdict, or null while the gate is still open
}

// ── Event view ────────────────────────────────────────────────────────────────────────────────────
// A single conductor event rendered in the activity feed. Wraps FLOW's closed `FlowEvent` union
// (the discriminated routing-decision/gate/node-enter/node-done vocabulary) with the display-only
// fields the feed needs — kept distinct from the on-disk event so the read-model can add view sugar
// without touching FLOW's contract.
export interface EventView {
  id: string; // stable feed key for this event
  event: FlowEvent; // FLOW's closed event (imported, not redeclared)
}

// ── Agent view ────────────────────────────────────────────────────────────────────────────────────
// One agent in the run roster as the UI shows it: who it is, what it's doing, and its FLOW live state
// (`working | blocked | done`, imported from FLOW's closed `AgentState`).
export interface AgentView {
  id: string; // the agent id
  role: string; // the dispatched agent type / role
  state: AgentState; // FLOW's closed live state (imported, not redeclared)
  task: string | null; // the task it is working, or null
}

// ── Token series ──────────────────────────────────────────────────────────────────────────────────
// A time series of token usage for the run's usage chart — parallel arrays of sample timestamps and
// cumulative token counts (the chart-friendly transport shape; the web layer turns it into points).
export interface TokenSeries {
  timestamps: string[]; // ISO sample timestamps
  tokens: number[]; // cumulative token count at each sample (same length as timestamps)
}

// ── Permission relay ──────────────────────────────────────────────────────────────────────────────
// One pending tool-approval prompt the agent relayed for a human verdict (FLOW Phase 3a's permission
// relay, channels.md §"Relay permission prompts"). FLOW writes a `<request_id>.json` request file when
// a tool needs approval and waits; the Workbench reads it, shows it, and on Allow/Deny writes a
// `<request_id>.verdict.json` FLOW emits to Claude Code. This shape MIRRORS FLOW's pinned on-disk
// `PermissionRequestFile` (the four relayed params + an ISO `created_at`) — it is NOT run-scoped:
// permissions are project/session-level, served on the base host. FLOW deletes the request file once
// the verdict is emitted (by the Workbench OR the terminal), so a request vanishing means it resolved.
export interface PermissionRequest {
  request_id: string; // the five-letter id FLOW issued (echoed back in the verdict)
  tool_name: string; // the tool needing approval, e.g. "Bash" / "Write" / "Edit"
  description: string; // human-readable summary of this specific call (the terminal-dialog text)
  input_preview: string; // the tool's args as JSON, truncated (~200 chars) — shown mono, truncated
  created_at: string; // ISO timestamp the request was raised
}

// ── WebSocket envelope ────────────────────────────────────────────────────────────────────────────
// The push messages the server streams to the web client over the local WebSocket. A discriminated
// union on `type` — the client switches on it. Four kinds: a raw file changed on disk, a parsed
// document was updated (carrying the fresh DocModel), a diff is ready to display, and a permission
// request appeared/resolved (the project-global approvals relay).

// A file on disk changed under the watched run — the low-level notification before parsing.
export interface FileChangedMessage {
  type: "file-changed";
  path: string; // the changed file path, relative to the run root
}

// A parsed document was updated — carries the doc id and the fresh read-model so the editor can
// reconcile without a refetch.
export interface DocUpdatedMessage {
  type: "doc-updated";
  docId: string;
  doc: DocModel;
}

// A diff for a document is ready to render (e.g. after a concurrent edit) — carries the doc id and the
// two versions being compared so the client can fetch/show the diff.
export interface DiffReadyMessage {
  type: "diff-ready";
  docId: string;
  baseVersion: string; // the version diffed from
  headVersion: string; // the version diffed to
}

// A permission request appeared or resolved (the project-global approvals relay). `added` carries the
// full `PermissionRequest` so the banner can render it without a refetch; `removed` carries only the id
// (FLOW deleted the request file — resolved in the terminal or by a verdict the Workbench wrote), so the
// banner drops it. NOT run-scoped: pushed to every connected client (the base host included).
export interface PermissionAddedMessage {
  type: "permission-added";
  request: PermissionRequest;
}

export interface PermissionRemovedMessage {
  type: "permission-removed";
  requestId: string;
}

export type WsMessage =
  | FileChangedMessage
  | DocUpdatedMessage
  | DiffReadyMessage
  | PermissionAddedMessage
  | PermissionRemovedMessage;
