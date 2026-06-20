// The custom React Flow node (task 13's visual layer). Renders one graph node in the dark-monochrome
// language ported from design/prototype-app.html's `DocNode`: a kind/status header, the task label,
// and a footer. Its visual state — pulse (in-progress) / dim (todo) / lit (done) — is driven entirely
// by the FLOW task status carried on the node data, plus the derived `blocked` overlay flag and the
// hover-highlight hint. It invents nothing: every visual derives from the read-model (DocNodeData,
// pinned by task 12's layout-dagre.ts).
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { DocNode as DocNodeType, DocNodeData } from "./layout-dagre.js";
import { useOpenCommentCount } from "./doc/comment-store.js";

// FLOW's closed status, reached transitively through the read-model (DocNodeData.status is FLOW's
// FlowTaskStatus) so the web package needn't depend on @agentry/flow directly — the type still ripples.
type FlowTaskStatus = DocNodeData["status"];

// FLOW's closed status → (human label, status-dot class, node visual-state class). A closed map: if
// FLOW adds a status, TypeScript flags the missing key here rather than silently rendering a blank.
const STATUS_VIEW: Record<FlowTaskStatus, { label: string; dot: string; state: string }> = {
  done: { label: "Done", dot: "s-done", state: "lit" },
  "in-progress": { label: "In progress", dot: "s-prog", state: "prog" },
  "in-review": { label: "In review", dot: "s-rev", state: "rev" },
  todo: { label: "To do", dot: "s-todo", state: "dim" },
};

export function DocNode({ id, data }: NodeProps<DocNodeType>) {
  const view = STATUS_VIEW[data.status];
  // Open review comments on this doc (AC5): the node id IS the docId (Panorama's selectDoc(n.id) and the
  // gate sidecar both key on it), so the badge reads the same shared store the rail/bubble write to. > 0
  // surfaces a small count so the panorama shows where a human is waited on, with no reload.
  const openComments = useOpenCommentCount(data.runId, id);
  // hover-highlight overrides the resting visual: a dimmed node loses its lit/prog emphasis. When
  // nothing is hovered (highlight === undefined), the status-derived resting state stands.
  const highlightClass =
    data.highlight === false ? "dim" : data.highlight === true ? "lit" : view.state;
  const className = ["rf-node", highlightClass, data.blocked ? "blocked" : ""].filter(Boolean).join(" ");

  return (
    <div className={className}>
      <Handle type="target" position={Position.Top} />
      <div className="rn-top">
        <span className="rn-kind">Task</span>
        <span className="rn-st">
          {openComments > 0 ? (
            <span
              className="rn-cmt"
              aria-label={`${openComments} open ${openComments === 1 ? "comment" : "comments"}`}
            >
              {openComments}
            </span>
          ) : null}
          <span className={`sdot ${view.dot}`} aria-hidden="true" />
          {view.label}
        </span>
      </div>
      <div className="rn-ttl">{data.label}</div>
      <div className="rn-foot">
        {data.blocked ? (
          <span className="rn-block">blocked</span>
        ) : (
          <span className="rn-who">
            <span className="faint">{data.status === "todo" ? "unassigned" : ""}</span>
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// The React Flow nodeTypes registry — Panorama (task 12) registers this under the "doc" key the
// layout emits (`type: "doc"`).
export const nodeTypes = { doc: DocNode } as const;
