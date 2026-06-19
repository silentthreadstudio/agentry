// The Live panorama — the React Flow canvas over a run's GraphModel (task 12). Ported from
// design/prototype-app.html's `Live`: a fitView'd Dagre DAG with a minimap, controls, the typed-edge
// legend, and hover-highlight. This file owns the canvas + the live data plumbing (fetch + ws); the
// node/edge *visuals* are task 13 (DocNode / edge-types), registered here via nodeTypes/edgeTypes.
//
// Live (AC7): the canvas subscribes to the ws stream (task 10's ws-client) and re-fetches the graph on
// any push — a node-enter / status change flips the node visuals (pulse/dim/lit) and lights an active
// blocks edge, with NO reload. Node state derives from the fresh GraphModel + FLOW status, never invented.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import type { GraphEdgeKind, GraphModel } from "@agentry/workbench-shared";
import { fetchGraph } from "../../../api/client.js";
import { getWsClient } from "../../../api/ws-client.js";
import { nodeTypes } from "./DocNode.js";
import { edgeTypes, Legend, markerForKind } from "./edge-types.js";
import { layoutGraph } from "./layout-dagre.js";

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
    () => (graph ? layoutGraph(graph, activeBlocks) : { nodes: [], edges: [] }),
    [graph, activeBlocks],
  );

  // hover-highlight: the hovered node + its direct neighbors stay lit; everything else dims. null = no
  // hover (resting status-derived visuals). Computed here (the canvas knows adjacency); the node/edge
  // components just honor the per-render `highlight` / opacity.
  const litSet = useMemo(() => {
    if (!hover || !graph) return null;
    const set = new Set<string>([hover]);
    for (const edge of graph.edges) {
      if (edge.from === hover) set.add(edge.to);
      if (edge.to === hover) set.add(edge.from);
    }
    return set;
  }, [hover, graph]);

  const nodes = useMemo(
    () =>
      base.nodes.map((n) => ({
        ...n,
        data: { ...n.data, highlight: litSet ? litSet.has(n.id) : undefined },
      })),
    [base.nodes, litSet],
  );

  const edges = useMemo(
    () =>
      base.edges.map((e) => {
        const lit = !litSet || (litSet.has(e.source) && litSet.has(e.target));
        const opacity = lit ? (litSet ? 1 : 0.85) : 0.18;
        return {
          ...e,
          animated: e.data?.active === true && lit,
          markerEnd: markerForKind(e.data?.kind as GraphEdgeKind),
          style: { opacity },
        };
      }),
    [base.edges, litSet],
  );

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

  return (
    <div className="flowwrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.3}
        nodesDraggable={false}
        proOptions={{ hideAttribution: true }}
        onNodeMouseEnter={(_e, n) => setHover(n.id)}
        onNodeMouseLeave={() => setHover(null)}
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
      <Legend />
    </div>
  );
}
