// RunPane — a run's content, previewed over the board.
//
// Clicking a card used to NAVIGATE to the v2 run view, whose default tab was the React Flow graph. Two
// things were wrong with that: you left the board (and the conversation you were having about it) to
// look at one run, and the first thing you were shown was a dependency graph rather than what the run
// actually says.
//
// So this is a PANE, not a page (doc 18 AC16). It dims the board only — the conductor rail stays lit
// and live beside it, because the point of an ambient conversation is talking about the thing you are
// currently looking at. Escape or the scrim closes it and the board is exactly where you left it.
//
// It is READ-ONLY on purpose. Editing, the comment rail, the graph and the timeline all still live in
// the full run view, one click away. A preview that quietly became an editor would be a worse version
// of the thing it links to.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import MarkdownIt from "markdown-it";
import type { BoardCard, GraphModel } from "@agentry/workbench-shared";
import { fetchGraph } from "../../api/index.js";
import { fetchDoc } from "../doc/doc-io.js";
import { runHref } from "./board-view.js";

// A preview renders trusted local files (the run's own artifacts), so linkify/typographer are the only
// niceties worth having; HTML stays OFF regardless — nothing should be able to inject markup into the
// workspace shell through a task body.
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

/** The docs a run has, in reading order: spec, plan, ADRs, then tasks by number. */
function docOrder(graph: GraphModel): { id: string; label: string }[] {
  const rank = (id: string) => (id === "spec" ? 0 : id === "plan" ? 1 : id.startsWith("adr") ? 2 : 3);
  return graph.nodes
    .filter((n) => n.id !== "routing" && n.id !== "adr-group")
    .map((n) => ({ id: n.id, label: n.label }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

export function RunPane({ card, onClose }: { card: BoardCard; onClose: () => void }) {
  const run = card.run ?? card.id;
  const navigate = useNavigate();
  const [docs, setDocs] = useState<{ id: string; label: string }[]>([]);
  const [docId, setDocId] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchGraph(run, ctrl.signal)
      .then((graph) => {
        const list = docOrder(graph);
        setDocs(list);
        // Open the spec first — it is what the run is FOR. Falling back to whatever exists keeps a
        // scaffold-only run previewable instead of showing an empty pane.
        setDocId((current) => current ?? list[0]?.id ?? null);
      })
      .catch(() => setDocs([]));
    return () => ctrl.abort();
  }, [run]);

  useEffect(() => {
    if (docId === null) return;
    const ctrl = new AbortController();
    setBody(null);
    fetchDoc(run, docId, ctrl.signal)
      .then((doc) => setBody(doc.body))
      .catch(() => {
        if (!ctrl.signal.aborted) setBody("");
      });
    return () => ctrl.abort();
  }, [run, docId]);

  const close = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <>
      {/* The scrim covers the BOARD only — it is a sibling inside the main column, so the rail is never
          dimmed and never stops updating. */}
      <div className="pane-scrim" onClick={close} />
      <section className={`runpane${wide ? " wide" : ""}`} role="dialog" aria-label={`Preview of ${card.title}`}>
        <div className="panehd">
          <span className="chip kind">{card.column}</span>
          <span className="t">{card.title}</span>
          <div className="grow" />
          <button type="button" className="ghost" onClick={() => setWide((w) => !w)} title="Widen">
            ⤢
          </button>
          <button type="button" className="ghost" onClick={() => navigate(runHref(run))}>
            Open full view
          </button>
          <button type="button" className="ghost" onClick={close}>
            Close
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
          {body === null ? (
            <p className="muted">Loading…</p>
          ) : body.trim().length === 0 ? (
            <p className="muted">This document is empty.</p>
          ) : (
            // The body is a local file the user's own agents wrote, and HTML is disabled in the parser
            // above, so the rendered output carries no markup the workspace did not produce.
            <div className="prose" dangerouslySetInnerHTML={{ __html: md.render(body) }} />
          )}
        </div>
      </section>
    </>
  );
}
