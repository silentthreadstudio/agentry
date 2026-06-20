// The ONLY place graph layout runs (SRP). Pure transform: a read-model `GraphModel` →
// React Flow nodes/edges with Dagre-computed, non-overlapping positions. No React, no I/O, no
// view state — Panorama calls this once per graph snapshot and feeds the result to <ReactFlow>.
//
// Ported from design/prototype-app.html's `layout()` (the dark-monochrome canvas's TB Dagre pass).
// The prototype hard-coded its DAG; here the same algorithm runs over the live `GraphModel`.
//
// ── ADR group transform (task 005, client-side) ────────────────────────────────────────────────────
// The server graph (buildGraph) emits one node per ADR (`adr-<key>`), each hung off the Plan with a
// `derives` edge. That sprawls the canvas for a decompose run with many ADRs. Here — and ONLY here, the
// server graph is never mutated — the individual ADRs are collapsed into ONE synthetic "Decisions"
// GROUP node (`adr-group`) hung off the same producer the ADRs hung off. The group is non-document
// (like routing): clicking it toggles expansion, it never opens a doc drawer. When EXPANDED, the
// individual ADR nodes are re-introduced (each IS a doc → clicking opens `adr-<key>`), the plan→adr
// derives edges are restored, and the plan→group edge is dropped. Dagre re-runs on every toggle, so the
// layout has no overlap in either state. The transform is keyed off the `expanded` flag Panorama owns.
//
// ── ELK escape hatch (VISION) ─────────────────────────────────────────────────────────────────────
// Layout is isolated behind this one function so a future large-DAG ELK swap is a single-file change:
// keep the `GraphModel → PositionedGraph` signature and replace the Dagre body. V1 ships Dagre only.
// Default import (not `import * as`): @dagrejs/dagre is CJS, and under Node's ESM interop the namespace
// form leaves `layout`/`graphlib` off the star object — the default gives the real module object, which
// works identically under esbuild/Vite. (Lets layout-dagre run under node:test, not just the bundler.)
import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphEdgeKind, GraphModel, GraphNode } from "@agentry/workbench-shared";
import type { Edge, Node } from "@xyflow/react";

// The visual kind of a node — drives BOTH the renderer (which shape: card / routing pill / ADR group)
// and the click gate (BUG 4a): only a `doc` node has a backing document and may open the drawer.
//   • doc     → spec / plan / adr-<key> / task-<NNN>: a card; clicking opens its doc.
//   • routing → the graph root: a distinct pill; NON-document, never opens a drawer.
//   • group   → the synthetic "Decisions" container: NON-document; clicking toggles ADR expansion.
export type NodeKind = "doc" | "routing" | "group";

// The synthetic group node's id. No server doc carries this id, so it can never collide with a real
// `adr-<key>` doc; the click gate keys on `kind`, not the id, so the `adr-`-prefix overlap is harmless.
export const ADR_GROUP_ID = "adr-group";

// ── The pinned node/edge data-prop contract (task 12 owns it; task 13's DocNode/edge-types plug in) ──
// The React Flow `data` payload a DocNode receives. Carries the read-model fields the node renders
// (label, FLOW status) plus the per-render hover-highlight hint. `blocked` is a derived overlay flag
// (the node is the target of an *active* blocks edge) — never a FLOW status value (no "blocked" status).
export interface DocNodeData {
  runId: string; // the run this node belongs to — lets the node read its open-comment count (badge, AC5)
  kind: NodeKind; // visual kind + click-gate discriminator (BUG 4a)
  label: string;
  status: GraphModel["nodes"][number]["status"]; // FLOW's closed FlowTaskStatus (imported, not redeclared)
  blocked: boolean; // overlay: targeted by an active `blocks` edge — derived, not a status
  // hover-highlight tri-state: undefined = nothing hovered; true = this node is lit; false = dimmed.
  highlight?: boolean;
  // ── group-only fields (kind === "group"): the "Decisions" container's rollup ──
  adrCount?: number; // how many ADRs this group rolls up (the count chip)
  expanded?: boolean; // whether the group is currently expanded (Panorama owns the flag)
  [key: string]: unknown; // React Flow requires node data to be an index-signature record
}

// The React Flow `data` payload an edge receives — its relationship kind drives the typed styling in
// edge-types.tsx, and `active` drives the blocks-edge glow overlay.
export interface DocEdgeData {
  kind: GraphEdgeKind;
  active: boolean; // overlay: a `blocks` edge whose blocker is in-progress (glows) — derived
  [key: string]: unknown;
}

export type DocNode = Node<DocNodeData, "doc">;
export type DocEdge = Edge<DocEdgeData>;

export interface PositionedGraph {
  nodes: DocNode[];
  edges: DocEdge[];
}

// Per-kind box dimensions — must match the rendered widths/heights (panorama.css) so Dagre reserves the
// right space and nodes never overlap. The routing pill is short; the ADR group is taller (title +
// 2-line description + count), and grows when expanded though its rolled-up children take their own slots.
export const NODE_WIDTH = 212;
export const NODE_HEIGHT = 96;
const ROUTING_WIDTH = 220;
const ROUTING_HEIGHT = 44;
const GROUP_WIDTH = 270;
const GROUP_HEIGHT = 118;

// Edge kinds that participate in the dependency DAG's layout ranking. `satisfies` is a cross-cutting
// acceptance link that would distort the top-down task flow, so it's drawn but not ranked (it still
// renders as an edge; it just doesn't pull its endpoints into adjacent ranks).
const LAYOUT_RANKING_KINDS: ReadonlySet<GraphEdgeKind> = new Set(["derives", "depends-on", "blocks"]);

const ADR_PREFIX = "adr-";
function isAdrId(id: string): boolean {
  return id.startsWith(ADR_PREFIX);
}

// The visual kind of a server node id (the synthetic group id is assigned by the transform, not seen here).
function kindOf(id: string): NodeKind {
  return id === "routing" ? "routing" : "doc";
}

// Per-kind Dagre box — keeps reserved space honest so the routing pill and ADR group don't overlap.
function boxOf(kind: NodeKind): { width: number; height: number } {
  if (kind === "routing") return { width: ROUTING_WIDTH, height: ROUTING_HEIGHT };
  if (kind === "group") return { width: GROUP_WIDTH, height: GROUP_HEIGHT };
  return { width: NODE_WIDTH, height: NODE_HEIGHT };
}

/**
 * Collapse the server graph's individual `adr-*` nodes into ONE synthetic "Decisions" group node when
 * `expanded` is false; pass the graph through unchanged (real ADR nodes + their plan→adr edges) when
 * `expanded` is true. PURE — the input GraphModel is never mutated; a new model is returned.
 *
 * Collapsed: every `adr-*` node is dropped, replaced by one `adr-group` node; each edge that touched an
 * ADR is rewritten to touch the group instead (deduped — the plan→adr1 / plan→adr2 derives edges collapse
 * to a single plan→group derives edge). The group inherits the ADRs' producer (the Plan), so it hangs in
 * the same place the ADRs did.
 *
 * Expanded: the model passes through as-is (no group node) so the real ADR docs render and open.
 *
 * A run with no ADRs returns the model untouched (no empty group).
 */
export function applyAdrGroup(model: GraphModel, expanded: boolean): GraphModel {
  const adrNodes = model.nodes.filter((n) => isAdrId(n.id));
  if (adrNodes.length === 0 || expanded) {
    // Nothing to collapse (or the group is expanded → show the real ADR nodes/edges unchanged).
    return model;
  }

  const adrIds = new Set(adrNodes.map((n) => n.id));
  const toGroup = (id: string): string => (adrIds.has(id) ? ADR_GROUP_ID : id);

  const nodes: GraphNode[] = [
    ...model.nodes.filter((n) => !adrIds.has(n.id)),
    {
      id: ADR_GROUP_ID,
      label: `Decisions·${adrNodes.length}`, // adrCount is re-read from the layout; label is a fallback
      status: "done", // a recorded decision is a settled fact (mirrors the server's ADR node status)
    },
  ];

  // Rewrite ADR-touching edges onto the group, dropping the now-self edges and de-duplicating (the N
  // plan→adr derives edges become ONE plan→group derives edge).
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of model.edges) {
    const from = toGroup(e.from);
    const to = toGroup(e.to);
    if (from === to) continue; // an edge wholly inside the ADR set (none today) collapses to a self-loop
    const key = `${from} ${to} ${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, kind: e.kind });
  }

  return { nodes, edges };
}

/**
 * Compute non-overlapping positions for a GraphModel and return React Flow nodes/edges ready to render.
 * The ADR group transform (`applyAdrGroup`) runs FIRST so layout sizes/positions reflect the collapsed
 * or expanded shape; Dagre then runs over whichever shape resulted (re-run per toggle by Panorama).
 *
 * @param runId       the run these nodes belong to — stamped onto each node's data so the node can read
 *                    its open-comment count for the badge (AC5). Pure: the layout itself doesn't use it.
 * @param model       the run's read-model graph (nodes carry FLOW status; edges carry the typed kind)
 * @param activeBlocks ids of nodes whose in-progress state makes their outgoing `blocks` edges "active"
 *                     (the blocker is running). Used to derive the per-node `blocked` flag + edge glow.
 * @param adrExpanded whether the ADR "Decisions" group is expanded (children visible). Default collapsed.
 */
export function layoutGraph(
  runId: string,
  model: GraphModel,
  activeBlocks: ReadonlySet<string> = new Set(),
  adrExpanded = false,
): PositionedGraph {
  const adrCount = model.nodes.filter((n) => isAdrId(n.id)).length;
  const view = applyAdrGroup(model, adrExpanded);

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", ranksep: 64, nodesep: 38, marginx: 30, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  const kindById = new Map<string, NodeKind>();
  for (const node of view.nodes) {
    const kind = node.id === ADR_GROUP_ID ? "group" : kindOf(node.id);
    kindById.set(node.id, kind);
    g.setNode(node.id, boxOf(kind));
  }
  // Only rank-participating edges shape the layout; every edge is still emitted for rendering below.
  for (const edge of view.edges) {
    if (LAYOUT_RANKING_KINDS.has(edge.kind) && hasNode(view, edge.from) && hasNode(view, edge.to)) {
      g.setEdge(edge.from, edge.to);
    }
  }

  dagre.layout(g);

  // A node is "blocked" (overlay) when an *active* `blocks` edge points at it.
  const blockedTargets = new Set<string>();
  for (const edge of view.edges) {
    if (edge.kind === "blocks" && activeBlocks.has(edge.from)) blockedTargets.add(edge.to);
  }

  const nodes: DocNode[] = view.nodes.map((node) => {
    const kind = kindById.get(node.id) ?? "doc";
    const box = boxOf(kind);
    const p = g.node(node.id);
    // Dagre centers nodes; React Flow positions by top-left corner — shift by half the box.
    const position = p ? { x: p.x - box.width / 2, y: p.y - box.height / 2 } : { x: 0, y: 0 };
    const data: DocNodeData = {
      runId,
      kind,
      label: node.label,
      status: node.status,
      blocked: blockedTargets.has(node.id),
    };
    if (kind === "group") {
      data.adrCount = adrCount;
      data.expanded = adrExpanded;
    }
    return { id: node.id, type: "doc", position, data };
  });

  const edges: DocEdge[] = view.edges.map((edge, i) => ({
    id: `e${i}-${edge.from}-${edge.to}`,
    source: edge.from,
    target: edge.to,
    type: edge.kind,
    data: { kind: edge.kind, active: edge.kind === "blocks" && activeBlocks.has(edge.from) },
  }));

  return { nodes, edges };
}

function hasNode(model: GraphModel, id: string): boolean {
  return model.nodes.some((n) => n.id === id);
}
