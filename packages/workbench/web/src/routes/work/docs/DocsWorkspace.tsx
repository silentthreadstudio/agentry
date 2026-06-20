// DocsWorkspace — the Docs work-level tab (task 008, the mockup's three-column workspace). The PRIMARY
// doc surface now that the drawer-over-graph is retired: a navigator (left) ⇄ the open-doc tab strip +
// editor (center) ⇄ the conversation rail (right). The graph stays "home" on the Live tab; docs open as
// TABS here.
//
// ── Wiring ──────────────────────────────────────────────────────────────────────────────────────────
//   • The tab state lives in `doc-tabs` (the open ids + the active one). A Live-graph node click, a
//     Decisions row, and the Gates `?doc=` jump all call `selectDoc(id)` → a tab opens/focuses here.
//   • The navigator tree + the active doc derive from the SAME GraphModel the canvas renders (fetched
//     once here, re-fetched on a ws push), so a row, a graph node, and a tab open the identical doc.
//   • The editor (DocEditor) and the rail (DocsRail) are keyed on the active doc id; `applyCommentMark`
//     is built once and threaded to the rail so a submitted comment paints the in-editor highlight.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphModel } from "@agentry/workbench-shared";
import { fetchGraph } from "../../../api/index.js";
import { getWsClient } from "../../../api/ws.js";
import { DocNavigator } from "./DocNavigator.js";
import { DocEditor, useApplyCommentMark, type DocMeta } from "./DocEditor.js";
import { DocsRail } from "./DocsRail.js";
import { GutterCommentButton } from "../live/doc/GutterCommentButton.js";
import {
  closeDocTab,
  selectDoc,
  useDocTabs,
} from "./doc-tabs.js";
import { buildDocTree } from "./doc-tree.js";
import { useDocsWorkspaceStyles } from "./docs-styles.js";

// FLOW status → the tab-strip status dot color (same hues as the navigator / mockup).
const STATUS_DOT: Record<string, string> = {
  done: "var(--done)",
  "in-progress": "var(--prog)",
  "in-review": "var(--rev)",
  todo: "var(--todo)",
};

export function DocsWorkspace({ runId }: { runId: string }) {
  useDocsWorkspaceStyles();
  const { open, active } = useDocTabs();
  const applyCommentMark = useApplyCommentMark();

  // The run's graph backs the navigator tree (and the tab labels). Fetched once, re-fetched on a ws push
  // (a status change should re-tint the navigator dots) — the same calm live behavior as the Panorama.
  const [graph, setGraph] = useState<GraphModel | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const refetch = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetchGraph(runId, ctrl.signal)
      .then(setGraph)
      .catch(() => {
        /* the workspace still works from the open tabs; the navigator just shows its empty state */
      });
  }, [runId]);

  useEffect(() => {
    refetch();
    return () => abortRef.current?.abort();
  }, [refetch]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = getWsClient().subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refetch();
      }, 200);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [refetch]);

  // Per-doc title/status, published by each open DocEditor as it loads — drives the tab labels + dots.
  const [meta, setMeta] = useState<Record<string, DocMeta>>({});
  const onLoaded = useCallback((id: string, m: DocMeta) => {
    setMeta((prev) => (prev[id]?.title === m.title && prev[id]?.status === m.status ? prev : { ...prev, [id]: m }));
  }, []);

  // Label/dot for an open tab: prefer the loaded meta; fall back to the navigator tree's row, then the id.
  const treeItems = useMemo(() => (graph ? buildDocTree(graph).flatMap((g) => g.items) : []), [graph]);
  const tabView = useCallback(
    (id: string): { label: string; status: string | null } => {
      const loaded = meta[id];
      if (loaded) return { label: loaded.title, status: loaded.status };
      const row = treeItems.find((i) => i.id === id);
      if (row) return { label: row.label, status: row.status };
      return { label: id, status: null };
    },
    [meta, treeItems],
  );

  return (
    <div className="dw-grid">
      <DocNavigator graph={graph} activeDocId={active} />

      <div className="dw-ed">
        {open.length > 0 ? (
          <div className="dw-tabbar" role="tablist" aria-label="Open documents">
            {open.map((id) => {
              const { label, status } = tabView(id);
              const on = id === active;
              return (
                <div
                  key={id}
                  role="tab"
                  aria-selected={on}
                  tabIndex={0}
                  className={`dw-tab${on ? " on" : ""}`}
                  onClick={() => selectDoc(id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectDoc(id);
                    }
                  }}
                >
                  {status ? (
                    <span className="dw-tab-sd" style={{ background: STATUS_DOT[status] ?? "var(--todo)" }} aria-hidden="true" />
                  ) : null}
                  <span>{label}</span>
                  <button
                    type="button"
                    className="dw-tab-x"
                    aria-label={`Close ${label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeDocTab(id);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="dw-edbody">
          {active ? (
            <>
              <DocEditor
                key={active}
                runId={runId}
                docId={active}
                applyCommentMark={applyCommentMark}
                onLoaded={(m) => onLoaded(active, m)}
              />
              {/* The margin 💬 trigger — floats in the editor's right gutter on a text selection. */}
              <GutterCommentButton runId={runId} docId={active} />
            </>
          ) : (
            <div className="dw-empty">
              No document open.
              <br />
              Pick one from the navigator, or click a node on the Live graph.
            </div>
          )}
        </div>
      </div>

      {active ? (
        <DocsRail runId={runId} docId={active} applyCommentMark={applyCommentMark} />
      ) : (
        <div className="dr-root">
          <div className="dr-hd">
            <b>Conversation</b>
          </div>
          <div className="dw-empty">Open a document to see its conversation.</div>
        </div>
      )}
    </div>
  );
}
