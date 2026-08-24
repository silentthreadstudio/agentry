// DocNavigator — the Docs workspace's left column: the run's documents as a grouped tree (Definition /
// Decisions / Tasks, with status dots), derived from the GraphModel via `buildDocTree`. A row click opens
// that doc's tab (`selectDoc`). The graph view lives on the top "Live graph" tab, so the old Documents⇄Graph
// toggle is gone; this column is documents-only. (The "Review all" walk-through was removed too — reviewing
// is free-form via comments.)
//
// The tree's data is the SAME GraphModel the canvas renders, so a row and a graph node open the identical doc.
import type { GraphModel } from "@agentry/workbench-shared";
import { buildDocTree, type DocTreeItem } from "./doc-tree.js";
import { selectDoc } from "./doc-tabs.js";

// FLOW status → the navigator status-dot color (the mockup's done/prog/rev/block/todo hues, tokens.css).
const STATUS_DOT: Record<string, string> = {
  done: "var(--done)",
  "in-progress": "var(--prog)",
  "in-review": "var(--rev)",
  todo: "var(--todo)",
};

export function DocNavigator({
  graph,
  activeDocId,
}: {
  graph: GraphModel | null;
  activeDocId: string | null;
}) {
  const groups = graph ? buildDocTree(graph) : [];

  return (
    <div className="nv-root">
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
