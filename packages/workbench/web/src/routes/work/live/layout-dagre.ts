// The ONLY place graph layout runs (SRP). Pure transform: a read-model `GraphModel` →
// React Flow nodes/edges with Dagre-computed, non-overlapping positions. No React, no I/O, no
// view state — Panorama calls this once per graph snapshot and feeds the result to <ReactFlow>.
//
// Ported from design/prototype-app.html's `layout()` (the dark-monochrome canvas's TB Dagre pass).
// The prototype hard-coded its DAG; here the same algorithm runs over the live `GraphModel`.
//
// ── ELK escape hatch (VISION) ─────────────────────────────────────────────────────────────────────
// Layout is isolated behind this one function so a future large-DAG ELK swap is a single-file change:
// keep the `GraphModel → PositionedGraph` signature and replace the Dagre body. V1 ships Dagre only.
import * as dagre from "@dagrejs/dagre";
import type { GraphEdgeKind, GraphModel } from "@agentry/workbench-shared";
import type { Edge, Node } from "@xyflow/react";

// ── The pinned node/edge data-prop contract (task 12 owns it; task 13's DocNode/edge-types plug in) ──
// The React Flow `data` payload a DocNode receives. Carries the read-model fields the node renders
// (label, FLOW status) plus the per-render hover-highlight hint. `blocked` is a derived overlay flag
// (the node is the target of an *active* blocks edge) — never a FLOW status value (no "blocked" status).
export interface DocNodeData {
  label: string;
  status: GraphModel["nodes"][number]["status"]; // FLOW's closed FlowTaskStatus (imported, not redeclared)
  blocked: boolean; // overlay: targeted by an active `blocks` edge — derived, not a status
  // hover-highlight tri-state: undefined = nothing hovered; true = this node is lit; false = dimmed.
  highlight?: boolean;
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

// Node box dimensions — must match the rendered .rf-node width/height (panorama.css) so Dagre reserves
// the right space and nodes never overlap.
export const NODE_WIDTH = 212;
export const NODE_HEIGHT = 96;

// Edge kinds that participate in the dependency DAG's layout ranking. `satisfies` is a cross-cutting
// acceptance link that would distort the top-down task flow, so it's drawn but not ranked (it still
// renders as an edge; it just doesn't pull its endpoints into adjacent ranks).
const LAYOUT_RANKING_KINDS: ReadonlySet<GraphEdgeKind> = new Set(["derives", "depends-on", "blocks"]);

/**
 * Compute non-overlapping positions for a GraphModel and return React Flow nodes/edges ready to render.
 *
 * @param model       the run's read-model graph (nodes carry FLOW status; edges carry the typed kind)
 * @param activeBlocks ids of nodes whose in-progress state makes their outgoing `blocks` edges "active"
 *                     (the blocker is running). Used to derive the per-node `blocked` flag + edge glow.
 */
export function layoutGraph(model: GraphModel, activeBlocks: ReadonlySet<string> = new Set()): PositionedGraph {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", ranksep: 64, nodesep: 38, marginx: 30, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of model.nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  // Only rank-participating edges shape the layout; every edge is still emitted for rendering below.
  for (const edge of model.edges) {
    if (LAYOUT_RANKING_KINDS.has(edge.kind) && hasNode(model, edge.from) && hasNode(model, edge.to)) {
      g.setEdge(edge.from, edge.to);
    }
  }

  dagre.layout(g);

  // A node is "blocked" (overlay) when an *active* `blocks` edge points at it.
  const blockedTargets = new Set<string>();
  for (const edge of model.edges) {
    if (edge.kind === "blocks" && activeBlocks.has(edge.from)) blockedTargets.add(edge.to);
  }

  const nodes: DocNode[] = model.nodes.map((node) => {
    const p = g.node(node.id);
    // Dagre centers nodes; React Flow positions by top-left corner — shift by half the box.
    const position = p ? { x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEIGHT / 2 } : { x: 0, y: 0 };
    return {
      id: node.id,
      type: "doc",
      position,
      data: { label: node.label, status: node.status, blocked: blockedTargets.has(node.id) },
    };
  });

  const edges: DocEdge[] = model.edges.map((edge, i) => ({
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
