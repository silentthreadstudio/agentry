// The Live panorama — the React Flow canvas over a run's GraphModel (task 12). Ported from
// design/prototype-app.html's `Live`: a fitView'd Dagre DAG with a minimap, controls, the typed-edge
// legend, and hover-highlight. This file owns the canvas + the live data plumbing (fetch + ws); the
// node/edge *visuals* are task 13 (DocNode / edge-types), registered here via nodeTypes/edgeTypes.
//
// Live (AC7): the canvas subscribes to the ws stream (task 10's ws-client) and re-fetches the graph on
// any push — a node-enter / status change flips the node visuals (pulse/dim/lit) and lights an active
// blocks edge, with NO reload. Node state derives from the fresh GraphModel + FLOW status, never invented.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import type { GraphEdgeKind, GraphModel } from "@agentry/workbench-shared";
import { fetchGraph } from "../../../api/index.js";
import { getWsClient } from "../../../api/ws.js";
import { AgentProvider, HoverProvider, nodeTypes } from "./DocNode.js";
import { edgeTypes, Legend, markerForKind } from "./edge-types.js";
import { AgentRoster } from "./AgentRoster.js";
import { useRoster } from "./use-roster.js";
import { layoutGraph } from "./layout-dagre.js";
import type { AdrRef, DocNode } from "./layout-dagre.js";
import { selectDoc } from "../docs/doc-tabs.js";
import { DecisionsDrawer, openDecisions } from "./DecisionsDrawer.js";

import "@xyflow/react/dist/style.css";
import "./panorama.css";

// The minimap dot color per FLOW status — keeps the overview legible in the same status hues.
const MINIMAP_STATUS_COLOR: Record<string, string> = {
  done: "#46b67e",
  "in-progress": "#d4a23a",
  "in-review": "#5b8fd6",
  todo: "#41414a",
};

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; graph: GraphModel };

// The run-as-graph canvas on the Live tab. A doc-node click navigates to the Docs workspace AND opens the
// doc's tab. (The compact "Graph" navigator mode was removed with the Documents⇄Graph toggle.)
export function Panorama({ runId }: { runId: string }) {
  return (
    <ReactFlowProvider>
      <PanoramaCanvas runId={runId} />
    </ReactFlowProvider>
  );
}

function PanoramaCanvas({ runId }: { runId: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [hover, setHover] = useState<string | null>(null);
  const navigate = useNavigate();

  // Fetch the graph; reused for the initial load and every live re-fetch. Aborts in flight on unmount.
  const abortRef = useRef<AbortController | null>(null);
  const refetch = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetchGraph(runId, ctrl.signal)
      .then((graph) => setLoad({ kind: "ready", graph }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoad({ kind: "error", message: err instanceof Error ? err.message : "failed to load graph" });
      });
  }, [runId]);

  useEffect(() => {
    refetch();
    return () => abortRef.current?.abort();
  }, [refetch]);

  // Live (AC7): any push means run state changed on disk — re-fetch the graph (debounced to coalesce
  // bursts). The fresh GraphModel re-derives every node/edge visual; no reload, no invented state.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = getWsClient().subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refetch();
      }, 120);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [refetch]);

  const graph = load.kind === "ready" ? load.graph : null;

  // active blockers: an in-progress node with an outgoing `blocks` edge — its block edge glows and its
  // targets read "blocked". Derived from the live graph (FLOW status), never invented.
  const activeBlocks = useMemo(() => {
    const set = new Set<string>();
    if (!graph) return set;
    const inProgress = new Set(graph.nodes.filter((n) => n.status === "in-progress").map((n) => n.id));
    for (const edge of graph.edges) {
      if (edge.kind === "blocks" && inProgress.has(edge.from)) set.add(edge.from);
    }
    return set;
  }, [graph]);

  const base = useMemo(
    () => (graph ? layoutGraph(runId, graph, activeBlocks) : { nodes: [], edges: [] }),
    [runId, graph, activeBlocks],
  );

  // RF-owned interaction state (task 007): seed the nodes/edges into useNodesState/useEdgesState and wire
  // onNodesChange/onEdgesChange so React Flow persists its own pan/zoom/measure state across renders and
  // stops re-measuring. The arrays are re-seeded ONLY when the GRAPH changes (the effect below, keyed on
  // `base`) — never on hover — so node identity is referentially stable and the canvas doesn't re-diff
  // every node as the cursor moves. The per-edge marker/animated flags are graph-derived (stable), not
  // hover-derived; the hover lit/dim now rides through HoverContext (read by DocNode / TypedEdge).
  const [nodes, setNodes, onNodesChange] = useNodesState(base.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    base.edges.map((e) => ({
      ...e,
      animated: e.data?.active === true,
      markerEnd: markerForKind(e.data?.kind as GraphEdgeKind),
    })),
  );

  // Sync the freshly-laid-out graph into the RF state when (and only when) the graph changes. Keyed on
  // `base` (which is memoized on runId/graph/activeBlocks) — a hover never reaches here, so the arrays keep
  // their identity across hovers. RF then preserves measured sizes/positions instead of re-measuring.
  useEffect(() => {
    setNodes(base.nodes);
    setEdges(
      base.edges.map((e) => ({
        ...e,
        animated: e.data?.active === true,
        markerEnd: markerForKind(e.data?.kind as GraphEdgeKind),
      })),
    );
  }, [base, setNodes, setEdges]);

  // The node click gate (BUG 4a): ONLY a backing-document node (`kind === "doc"`) opens a doc. The routing
  // root and the synthetic ADR group container carry no doc — clicking them must NOT call selectDoc (no 404
  // fetch). The group opens the Decisions drawer (a list → each ADR's doc); routing is inert.
  //
  // Opening a doc means "open its tab in the Docs workspace and switch to it": selectDoc + navigate to /docs.
  const onNodeClick = useCallback(
    (_e: unknown, n: DocNode) => {
      const kind = n.data.kind;
      if (kind === "group") {
        openDecisions((n.data.adrs as AdrRef[] | undefined) ?? []);
        return;
      }
      if (kind !== "doc") return; // routing (or any non-doc) → never opens a doc
      selectDoc(n.id);
      navigate("docs");
    },
    [navigate],
  );

  // hover-highlight: the hovered node + its direct neighbors stay lit; everything else dims. null = no
  // hover (resting status-derived visuals). Computed here (the canvas knows adjacency) and published
  // through HoverContext — NOT stamped onto the nodes/edges arrays — so the canvas arrays stay stable and
  // only the (memo'd) DocNode/TypedEdge consumers whose lit state flipped re-render. This is the core fix:
  // hover no longer rebuilds the graph, so React Flow no longer re-diffs/re-measures every node (no flicker).
  const litSet = useMemo(() => {
    if (!hover || !graph) return null;
    const set = new Set<string>([hover]);
    for (const edge of graph.edges) {
      if (edge.from === hover) set.add(edge.to);
      if (edge.to === hover) set.add(edge.from);
    }
    return set;
  }, [hover, graph]);

  const hoverValue = useMemo(() => ({ litSet }), [litSet]);

  // Live agent overlay (doc 10 §3a): who's on which node + the roster. Fetched + ws-refreshed in the hook;
  // the `byNode` map rides AgentContext (stable across timer ticks — the chip/panel tick their own clocks).
  const roster = useRoster(runId);
  const agentValue = useMemo(() => ({ byNode: roster.byNode }), [roster]);

  // Stabilize hover (task 007): as the cursor pans across the canvas it crosses node boundaries, firing
  // enter/leave in quick succession. Toggling hover id→null→id restarts the lit/dim CSS transitions and
  // flashes. Guard against no-op sets, and debounce the leave→null by a frame so an immediately-following
  // enter (the next node under the cursor) cancels the clear — the highlight slides node→node, never blinks
  // through the resting state.
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onNodeEnter = useCallback((_e: unknown, n: { id: string }) => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    setHover((prev) => (prev === n.id ? prev : n.id));
  }, []);
  const onNodeLeave = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      setHover(null);
    }, 60);
  }, []);
  useEffect(() => () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  }, []);

  if (load.kind === "loading") {
    return <div className="flowwrap" aria-busy="true" />;
  }
  if (load.kind === "error") {
    return (
      <div className="page">
        <p className="muted">Couldn't load the graph: {load.message}</p>
      </div>
    );
  }
  // Empty state (task #2): a fresh run with no artifacts yet renders nothing on the React Flow canvas — a
  // blank void. Show a calm "nothing here yet" instead, so the graph reads as waiting, not broken. The live
  // ws loop re-fetches as soon as the agent writes the first artifact, so this resolves to the graph on its own.
  if (load.graph.nodes.length === 0) {
    return (
      <div className="flowwrap pano-empty">
        <div className="pano-empty-card">
          <span className="pano-empty-glyph" aria-hidden="true">◳</span>
          <h2>No work yet</h2>
          <p>
            This run hasn’t produced any artifacts. The graph fills in live as the agent routes the task,
            writes the spec and plan, and dispatches the work.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flowwrap">
      <HoverProvider value={hoverValue}>
       <AgentProvider value={agentValue}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          minZoom={0.3}
          nodesDraggable={false}
          proOptions={{ hideAttribution: true }}
          onNodeMouseEnter={onNodeEnter}
          onNodeMouseLeave={onNodeLeave}
          onNodeClick={onNodeClick}
        >
          <Background color="#20202a" gap={26} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            maskColor="rgba(13,13,17,.7)"
            nodeColor={(n) => {
              const status = (n.data as { status?: string } | undefined)?.status ?? "todo";
              return MINIMAP_STATUS_COLOR[status] ?? "#41414a";
            }}
          />
        </ReactFlow>
       </AgentProvider>
      </HoverProvider>
      <AgentRoster agents={roster.agents} />
      <Legend />
      {/* Task 008: the drawer-over-graph is RETIRED. A doc-node click now opens the doc as a TAB in the
          Docs workspace (selectDoc + navigate to /docs); the editor / comment rail / diff drawer all live
          there now. The Decisions list stays — clicking the ADR group node opens it; each row routes to
          the ADR's tab in the Docs workspace. */}
      <DecisionsDrawer onOpenDoc={() => navigate("docs")} />
    </div>
  );
}
