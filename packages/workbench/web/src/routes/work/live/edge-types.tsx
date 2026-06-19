// The four typed edges + the legend (task 13's visual layer). Ported from design/prototype-app.html's
// EDGE_STYLE map + legend. Each GraphEdgeKind renders visually distinct, per VISION/AC3:
//   derives / depends-on → solid neutral arrow      (the structural / dependency spine)
//   blocks               → dashed accent-red, labelled, animated when active (the glow overlay)
//   satisfies            → dotted faint              (the acceptance link, drawn but de-emphasised)
//
// Styling lives here (one place, by kind); Panorama (task 12) owns *which* edges are lit/dimmed
// (hover-highlight) and *which* blocks edges are active — it passes those through `style.opacity` and
// the edge `data.active` flag the layout sets. We read the kind from `data`, draw the path, and let
// the caller's opacity ride on top. We invent no relationship — the kind comes from the read-model.
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, MarkerType } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import type { GraphEdgeKind } from "@agentry/workbench-shared";
import type { DocEdge } from "./layout-dagre.js";

// The per-kind visual vocabulary. Neutral hue for the structural spine; accent-red for blocks; a faint
// dotted line for satisfies. Colors mirror the design tokens (--line2 / --block / a faint --line2).
const NEUTRAL = "#34343e";
const BLOCK = "#e0685a";
const FAINT = "#3a3a44";

interface EdgeKindStyle {
  stroke: string;
  width: number;
  dash?: string;
}

const KIND_STYLE: Record<GraphEdgeKind, EdgeKindStyle> = {
  derives: { stroke: NEUTRAL, width: 1.6 },
  "depends-on": { stroke: NEUTRAL, width: 1.4 },
  blocks: { stroke: BLOCK, width: 1.8, dash: "5 5" },
  satisfies: { stroke: FAINT, width: 1.4, dash: "1 5" },
};

// One reusable typed-edge renderer. The kind selects the visual; `data.active` (a blocks edge whose
// blocker is running) turns on the animated glow; the caller's `style.opacity` rides on top for the
// hover-highlight dim. A single component keeps the four kinds from drifting apart.
function TypedEdge(kind: GraphEdgeKind) {
  function Edge({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    markerEnd,
    style,
    data,
  }: EdgeProps<DocEdge>) {
    const [path, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    });
    const kindStyle = KIND_STYLE[kind];
    const active = kind === "blocks" && data?.active === true;
    const edgeStyle: React.CSSProperties = {
      stroke: kindStyle.stroke,
      strokeWidth: kindStyle.width,
      ...(kindStyle.dash ? { strokeDasharray: kindStyle.dash } : {}),
      // Panorama's hover-highlight opacity rides on top of the kind's base stroke.
      ...(style ?? {}),
    };
    return (
      <>
        <BaseEdge
          path={path}
          {...(markerEnd ? { markerEnd } : {})}
          style={edgeStyle}
          {...(active ? { className: "rf-edge-blocks-active" } : {})}
        />
        {kind === "blocks" ? (
          <EdgeLabelRenderer>
            <div
              className="rf-edge-label rf-edge-label-blocks"
              style={{
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                opacity: typeof edgeStyle.opacity === "number" ? edgeStyle.opacity : 1,
              }}
            >
              blocks
            </div>
          </EdgeLabelRenderer>
        ) : null}
      </>
    );
  }
  Edge.displayName = `TypedEdge(${kind})`;
  return Edge;
}

// The React Flow edgeTypes registry — Panorama registers it; the layout emits `type: <kind>` per edge.
export const edgeTypes = {
  derives: TypedEdge("derives"),
  "depends-on": TypedEdge("depends-on"),
  blocks: TypedEdge("blocks"),
  satisfies: TypedEdge("satisfies"),
} as const;

// The arrowhead marker each typed edge points with — Panorama applies it per-edge with the kind's hue.
export function markerForKind(kind: GraphEdgeKind) {
  return { type: MarkerType.ArrowClosed, color: KIND_STYLE[kind].stroke, width: 14, height: 14 } as const;
}

// The legend (bottom-left of the canvas) naming the four edge kinds — ported from the prototype. It is
// the key that makes the typed edges legible: a line sample + its meaning.
export function Legend() {
  return (
    <div className="legend" aria-label="Edge legend">
      <div className="r">
        <span className="ln" style={{ borderColor: NEUTRAL, borderTopStyle: "solid" }} />
        derives / depends-on
      </div>
      <div className="r">
        <span className="ln" style={{ borderColor: BLOCK, borderTopStyle: "dashed" }} />
        blocks
      </div>
      <div className="r">
        <span className="ln" style={{ borderColor: FAINT, borderTopStyle: "dotted" }} />
        satisfies
      </div>
    </div>
  );
}
