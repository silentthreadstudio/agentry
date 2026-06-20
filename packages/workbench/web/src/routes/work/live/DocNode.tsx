// The custom React Flow node (task 13's visual layer; redesigned in task 005 to the Option-B card from
// design/node-mockups.html). ONE component renders three visual kinds off `data.kind`:
//   • doc     → the Option-B CARD: a header (kind glyph + `kind · id` label + status pill), a title, and
//               a footer (agent avatar if known · version short-hash if known · open-comment badge).
//   • routing → a distinct ROOT PILL ("routing · <shape>") — a decision, not a document (BUG 4a: it never
//               opens a drawer; Panorama gates the click on `kind`).
//   • group   → the "Decisions" ADR GROUP: a single unified card — a title + 2-line description + ADR
//               count. Non-doc (BUG 4a); clicking opens the Decisions drawer that lists the ADRs (no
//               canvas-expand). The card itself never changes shape.
//
// Visual STATE — pulse (in-progress) / dim (todo) / lit (done) / blocked — is driven entirely by the FLOW
// task status carried on the node data, plus the derived `blocked` overlay flag and the hover-highlight
// hint. It invents nothing: every visual derives from the read-model (DocNodeData, pinned by layout-dagre).
import { createContext, memo, useContext, useMemo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { DocNode as DocNodeType, DocNodeData } from "./layout-dagre.js";
import { useOpenCommentCount } from "./doc/comment-store.js";

// ── Hover-highlight context (task 007: kill the node flicker) ───────────────────────────────────────
// The hover-highlight (lit the hovered node + its neighbors, dim the rest) used to be stamped onto every
// node's `data` on each hover — which rebuilt the whole `nodes`/`edges` arrays with fresh object refs and
// made React Flow re-diff + re-measure all ~37 nodes every time the cursor moved (the flicker). Instead,
// Panorama keeps the node/edge arrays referentially STABLE (they change only when the GRAPH changes) and
// publishes the hover state through this context. The memo'd DocNode (and TypedEdge in edge-types) read it
// and derive their own lit/dim class — so a hover re-renders only the cheap context consumers, not the
// canvas. `litSet === null` means nothing is hovered (resting status-derived visuals stand).
export interface HoverHighlight {
  litSet: ReadonlySet<string> | null;
}
export const HoverContext = createContext<HoverHighlight>({ litSet: null });
export const HoverProvider = HoverContext.Provider;

// The tri-state lit/dim hint for a node id, read from the hover context: undefined = nothing hovered
// (resting visual); true = this node is in the lit set; false = dimmed. Mirrors the old `data.highlight`
// tri-state so the node's class logic is unchanged — only its source moved from props to context.
function useHighlight(id: string): boolean | undefined {
  const { litSet } = useContext(HoverContext);
  return litSet ? litSet.has(id) : undefined;
}

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

// The header's kind glyph + `kind · id` label, derived from the doc node id. The server labels carry the
// kind as a prefix ("spec", "plan", "adr <key>: <title>", "<taskNo> <title>"); here we read the id (the
// stable identity) for the glyph + short label, and use the server label as the card title.
interface KindView {
  glyph: string;
  kindLabel: string; // the uppercased "kind · id" line in the header
  accent: boolean; // glyph uses the accent treatment (spec/plan/adr — the design artifacts)
}
function kindViewOf(id: string): KindView {
  if (id === "spec") return { glyph: "§", kindLabel: "Spec", accent: true };
  if (id === "plan") return { glyph: "▦", kindLabel: "Plan", accent: true };
  if (id.startsWith("adr-")) return { glyph: "◇", kindLabel: `ADR · ${id.slice(4)}`, accent: true };
  if (id.startsWith("task-")) return { glyph: "▤", kindLabel: `Task · ${id.slice(5)}`, accent: false };
  return { glyph: "▤", kindLabel: id, accent: false };
}

// Strip the server label's "kind:" / "kind " prefix so the card title reads as the human title alone
// (e.g. "adr 001: server stateless" → "server stateless"; "014 markdown-serializer" → "markdown-serializer").
// Falls back to the whole label when there's no recognizable prefix (spec/plan are their own title).
function titleOf(id: string, label: string): string {
  if (id.startsWith("adr-")) {
    const colon = label.indexOf(":");
    return colon >= 0 ? label.slice(colon + 1).trim() : label;
  }
  if (id.startsWith("task-")) {
    const space = label.indexOf(" ");
    return space >= 0 ? label.slice(space + 1).trim() : label;
  }
  return label;
}

// memo'd (task 007): with the node array referentially stable across hovers, React Flow no longer hands a
// fresh `data` ref to every node each hover — so memo lets the ~37 nodes skip re-render on hover. The
// lit/dim hint is read from HoverContext inside the leaf cards, not threaded through props, so a hover only
// re-renders the (cheap) cards whose lit state actually flipped via the context update.
export const DocNode = memo(function DocNode({ id, data }: NodeProps<DocNodeType>) {
  if (data.kind === "routing") return <RoutingNode label={data.label} />;
  if (data.kind === "group") return <GroupNode id={id} data={data} />;
  return <DocCard id={id} data={data} />;
});

// ── Option-B card (a backing-document node) ───────────────────────────────────────────────────────────
function DocCard({ id, data }: { id: string; data: DocNodeData }) {
  const view = STATUS_VIEW[data.status];
  const kind = kindViewOf(id);
  const title = titleOf(id, data.label);
  // Open review comments on this doc (AC5): the node id IS the docId (Panorama's selectDoc(n.id) and the
  // gate sidecar both key on it), so the badge reads the same shared store the rail/bubble write to.
  const openComments = useOpenCommentCount(data.runId, id);
  // hover-highlight overrides the resting visual: a dimmed node loses its lit/prog emphasis. When nothing
  // is hovered (highlight === undefined), the status-derived resting state stands. Read from HoverContext
  // (task 007) instead of `data` so the node array stays stable across hovers.
  const highlight = useHighlight(id);
  const highlightClass = highlight === false ? "dim" : highlight === true ? "lit" : view.state;
  const className = ["bn-node", highlightClass, data.blocked ? "blocked" : ""].filter(Boolean).join(" ");

  return (
    <div className={className}>
      <Handle type="target" position={Position.Top} />
      <div className="bn-hd">
        <span className={`bn-glyph${kind.accent ? " accent" : ""}`} aria-hidden="true">
          {kind.glyph}
        </span>
        <span className="bn-kind">{kind.kindLabel}</span>
        <span className={`bn-pill ${view.state}`}>
          <span className={`sdot ${view.dot}`} aria-hidden="true" />
          {data.blocked ? "Blocked" : view.label}
        </span>
      </div>
      <div className="bn-bd">
        <div className="bn-ttl">{title}</div>
      </div>
      <div className="bn-ft">
        {data.blocked ? (
          <span className="bn-block">blocked — waiting upstream</span>
        ) : data.status === "todo" ? (
          <span className="bn-faint">unassigned</span>
        ) : (
          <span className="bn-faint">{kind.kindLabel}</span>
        )}
        {openComments > 0 ? (
          <span
            className="bn-cmt"
            aria-label={`${openComments} open ${openComments === 1 ? "comment" : "comments"}`}
          >
            ◆ {openComments}
          </span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// ── Routing root pill (a decision, not a document — BUG 4a) ────────────────────────────────────────────
function RoutingNode({ label }: { label: string }) {
  // The server label is "routing: <shape>"; show the shape as the emphasized text, "routing" as the kicker.
  const shape = label.startsWith("routing:") ? label.slice("routing:".length).trim() : label;
  return (
    <div className="bn-root">
      <Handle type="target" position={Position.Top} />
      <span className="bn-root-k">Routing</span>
      <b>{shape}</b>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// ── ADR "Decisions" group (non-document, single unified card — BUG 4a) ─────────────────────────────────
// Always one card: title + 2-line description + ADR count. Clicking it opens the Decisions drawer (which
// lists the ADRs and routes each to its doc) — there is no canvas-expand and the card never changes shape.
function GroupNode({ id, data }: { id: string; data: DocNodeData }) {
  const count = data.adrCount ?? 0;
  const highlight = useHighlight(id);
  const highlightClass = highlight === false ? "dim" : highlight === true ? "lit" : "";
  const className = ["bn-group", highlightClass].filter(Boolean).join(" ");
  return (
    <div className={className}>
      <Handle type="target" position={Position.Top} />
      <div className="bn-glab">
        <span aria-hidden="true">◇</span>
        Decisions
        <span className="bn-c">
          {count} {count === 1 ? "ADR" : "ADRs"}
        </span>
      </div>
      <div className="bn-gttl">Architecture decisions</div>
      <div className="bn-gsub">
        The recorded forks that shape the plan — each constrains the tasks below.
      </div>
      <div className="bn-gtoggle">click to view</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// The React Flow nodeTypes registry — Panorama (task 12) registers this under the "doc" key the
// layout emits (`type: "doc"`). The single node type fans out to card / routing / group by `data.kind`.
export const nodeTypes = { doc: DocNode } as const;
