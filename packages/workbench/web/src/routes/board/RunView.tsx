// RunView — one run's documents, filling the work column.
//
// This started as a PANE over the board and that was wrong. Reviewing a ticket means reading a document
// and its comments together, and an overlay that takes a third of the window leaves prose wrapping every
// four words with the comment column spilling off the edge. Review is the work, not a peek at it.
//
// So the workspace is TWO PERSISTENT COLUMNS — the work surface, and the conversation — and the work
// surface SWITCHES between the board and an open run. Opening a run expands it to the full column, the
// way the chat's focus mode expands: same shell, same conversation still live beside it, no scrim and
// nothing dimmed. Leaving is one Escape (or the back link) and the board is exactly as you left it.
//
// It is the FULL doc surface (doc 19 B5): read, edit, comment, resolve. It COMPOSES the existing editor
// and comment rail rather than embedding `DocsWorkspace`, whose own three-column layout would nest a
// navigator inside a column that already sits beside the conversation — three levels of chrome for one
// document. The navigator's job is done here by the tab strip.
import { useCallback, useEffect, useState } from "react";
import type { BoardCard, GraphModel } from "@agentry/workbench-shared";
import { fetchGraph } from "../../api/index.js";
import { getWsClient } from "../../api/ws.js";
import { CommentRail } from "../doc/CommentRail.js";
import { DocEditor, useApplyCommentMark } from "../doc/DocEditor.js";

/** The docs a run has, in reading order: spec, plan, ADRs, then tasks by number. */
function docOrder(graph: GraphModel): { id: string; label: string }[] {
  const rank = (id: string) => (id === "spec" ? 0 : id === "plan" ? 1 : id.startsWith("adr") ? 2 : 3);
  return graph.nodes
    .filter((n) => n.id !== "routing" && n.id !== "adr-group")
    .map((n) => ({ id: n.id, label: n.label }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

export function RunView({ card, onClose }: { card: BoardCard; onClose: () => void }) {
  const run = card.run ?? card.id;
  const [docs, setDocs] = useState<{ id: string; label: string }[]>([]);
  const [docId, setDocId] = useState<string | null>(null);
  const [comments, setComments] = useState(true);
  const applyCommentMark = useApplyCommentMark();

  const loadDocs = useCallback(
    (signal?: AbortSignal) => {
      fetchGraph(run, signal)
        .then((graph) => {
          const list = docOrder(graph);
          setDocs(list);
          // Open the spec first — it is what the run is FOR. Falling back to whatever exists keeps a
          // scaffold-only run usable instead of showing an empty pane.
          setDocId((current) => current ?? list[0]?.id ?? null);
        })
        .catch(() => setDocs([]));
    },
    [run],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    loadDocs(ctrl.signal);
    return () => ctrl.abort();
  }, [loadDocs]);

  // A task appearing or a status flipping re-tints the strip without a reload.
  useEffect(() => {
    return getWsClient().subscribe((msg) => {
      if (msg.type === "works-changed" || msg.type === "file-changed") loadDocs();
    });
  }, [loadDocs]);

  const close = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the pane — unless something inside it (a composer, a menu) already handled the
      // key, so one press does one thing.
      if (e.key === "Escape" && !e.defaultPrevented) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <section className="runview" aria-label={`${card.title} documents`}>
      <div className="panehd">
        {/* Back, not Close: this is a place you navigated to, and the board is where you came from. */}
        <button type="button" className="ghost back" onClick={close} aria-label="Back to the board">
          ←
        </button>
        <span className="chip kind">{card.column}</span>
        <span className="t">{card.title}</span>
        <div className="grow" />
        <button
          type="button"
          className={`ghost${comments ? " on" : ""}`}
          onClick={() => setComments((c) => !c)}
          aria-pressed={comments}
        >
          Comments
        </button>
      </div>

      {docs.length > 1 ? (
        <nav className="panetabs" aria-label="Documents">
          {docs.map((d) => (
            <button
              key={d.id}
              type="button"
              className={d.id === docId ? "on" : ""}
              onClick={() => setDocId(d.id)}
              title={d.label}
            >
              {d.id}
            </button>
          ))}
        </nav>
      ) : null}

      <div className="panebody">
        {docId === null ? (
          <p className="muted">This run has no documents yet.</p>
        ) : (
          <>
            <div className="panedoc">
              <DocEditor runId={run} docId={docId} applyCommentMark={applyCommentMark} />
            </div>
            {/* Comments are where gates get answered, so they are ON by default and collapsible rather
                than hidden behind a mode — a gate you cannot see is a gate you cannot clear. */}
            {comments ? (
              <aside className="panecomments">
                <CommentRail runId={run} docId={docId} applyCommentMark={applyCommentMark} />
              </aside>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
