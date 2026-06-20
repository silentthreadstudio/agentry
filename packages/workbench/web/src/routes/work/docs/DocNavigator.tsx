// DocNavigator — the Docs workspace's left column (task 008, the mockup's `.nav`). A segmented
// Documents ⇄ Graph toggle over:
//   • Documents → the run's docs as a grouped tree (Definition / Decisions / Tasks, with status dots),
//     derived from the GraphModel via `buildDocTree`. A row click opens that doc's tab (`selectDoc`).
//   • Graph     → the existing <Panorama> in a compact navigator mode; a node click opens its doc tab
//     (Panorama already routes a doc-node click through `selectDoc`).
// A "Review all docs" card sits at the bottom — the walk-through entry (a stub for now; see the workspace).
//
// The tree's data is the SAME GraphModel the canvas renders, so a row and a node open the identical doc.
import { useState } from "react";
import type { GraphModel } from "@agentry/workbench-shared";
import { Panorama } from "../live/Panorama.js";
import { buildDocTree, type DocTreeItem } from "./doc-tree.js";
import { selectDoc } from "./doc-tabs.js";

// FLOW status → the navigator status-dot color (the mockup's done/prog/rev/block/todo hues, tokens.css).
const STATUS_DOT: Record<string, string> = {
  done: "var(--done)",
  "in-progress": "var(--prog)",
  "in-review": "var(--rev)",
  todo: "var(--todo)",
};

type NavMode = "documents" | "graph";

export function DocNavigator({
  runId,
  graph,
  activeDocId,
  onReviewAll,
}: {
  runId: string;
  graph: GraphModel | null;
  activeDocId: string | null;
  onReviewAll: () => void;
}) {
  const [mode, setMode] = useState<NavMode>("documents");
  const groups = graph ? buildDocTree(graph) : [];

  return (
    <div className="nv-root">
      <div className="nv-hd">
        <div className="nv-seg" role="group" aria-label="Navigator mode">
          <button
            type="button"
            className={`nv-seg-b${mode === "documents" ? " on" : ""}`}
            onClick={() => setMode("documents")}
          >
            Documents
          </button>
          <button
            type="button"
            className={`nv-seg-b${mode === "graph" ? " on" : ""}`}
            onClick={() => setMode("graph")}
          >
            Graph
          </button>
        </div>
      </div>

      {mode === "documents" ? (
        <nav className="nv-tree" aria-label="Run documents">
          {groups.length === 0 ? (
            <div className="nv-empty">No documents yet.</div>
          ) : (
            groups.map((g) => (
              <div key={g.key}>
                <div className="nv-grp">{g.heading}</div>
                {g.items.map((item) => (
                  <TreeRow
                    key={item.id}
                    item={item}
                    active={item.id === activeDocId}
                    onOpen={() => selectDoc(item.id)}
                  />
                ))}
              </div>
            ))
          )}
        </nav>
      ) : (
        <div className="nv-graph">
          <Panorama runId={runId} compact />
        </div>
      )}

      <div className="nv-review">
        <b>Review all docs</b>
        <p>Walk spec → plan → tasks, annotate, send once.</p>
        <button type="button" onClick={onReviewAll}>
          Start review →
        </button>
      </div>
    </div>
  );
}

function TreeRow({
  item,
  active,
  onOpen,
}: {
  item: DocTreeItem;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" className={`nv-item${active ? " on" : ""}`} onClick={onOpen} aria-current={active}>
      <span className="nv-g" aria-hidden="true">{item.glyph}</span>
      <span className="nv-nm">{item.label}</span>
      {item.status ? (
        <span
          className="nv-sd"
          style={{ background: STATUS_DOT[item.status] ?? "var(--todo)" }}
          aria-hidden="true"
        />
      ) : null}
    </button>
  );
}
