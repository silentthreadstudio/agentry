// DecisionsDrawer — the "Decisions" list panel over the dimmed Panorama (task 006). The ADR group node
// (layout-dagre's `adr-group`) is ALWAYS a single non-document card; clicking it opens THIS drawer, which
// lists the run's ADRs (id + title) and routes each row to its doc via the existing `selectDoc('adr-<key>')`
// contract (DocDrawer). There is no canvas-expand: the individual ADRs live here, not on the graph.
//
// Mirrors DocDrawer's open seam (a tiny module-level store + `useDecisionsOpen()`), overlay-over-dimmed-
// graph style (`.dd-overlay`-shaped), and Escape-to-close a11y. The ADR refs come from the group node's
// `data.adrs` (pulled from the GraphModel during the collapse) — no re-fetch.
import { useEffect, useSyncExternalStore } from "react";
import type { AdrRef } from "./layout-dagre.js";
import { selectDoc } from "./doc/DocDrawer.js";

// ── The open seam (mirrors DocDrawer's selectDoc store) ───────────────────────────────────────────────
// Panorama calls `openDecisions(adrs)` on a group-node click; this drawer subscribes via `useDecisionsOpen`.
// Kept module-level (not React state lifted through props) so the open contract lives in the one component
// that owns it — the Panorama side only needs the exported `openDecisions` / `closeDecisions`.
let openAdrs: AdrRef[] | null = null;
const listeners = new Set<() => void>();

/** Open the Decisions drawer over the given ADR refs (called by the Panorama group-node click). */
export function openDecisions(adrs: AdrRef[]): void {
  openAdrs = adrs;
  for (const l of listeners) l();
}

/** Close the Decisions drawer (Escape, the close button, or a row click that hands off to a doc). */
export function closeDecisions(): void {
  if (openAdrs === null) return;
  openAdrs = null;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The currently-open ADR refs (null = drawer closed). Drives DecisionsDrawer's open/closed state. */
function useDecisionsOpen(): AdrRef[] | null {
  return useSyncExternalStore(subscribe, () => openAdrs, () => openAdrs);
}

// The server ADR label is "adr <key>: <title>" — show the key as the row kicker and the title as the row
// text. Falls back to the whole label when there's no recognizable prefix. Mirrors DocNode's id/label split.
function rowView(adr: AdrRef): { key: string; title: string } {
  const key = adr.id.startsWith("adr-") ? adr.id.slice("adr-".length) : adr.id;
  const colon = adr.label.indexOf(":");
  const title = colon >= 0 ? adr.label.slice(colon + 1).trim() : adr.label;
  return { key, title };
}

export function DecisionsDrawer() {
  useDecisionsStyles();
  const adrs = useDecisionsOpen();

  // Escape closes the drawer (a11y: a modal dialog must be dismissable from the keyboard). Bound only
  // while open; window-level so it fires regardless of where focus sits inside the panel.
  useEffect(() => {
    if (adrs === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDecisions();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adrs]);

  if (adrs === null) return null;

  // A row hands off to the ADR's doc: open it in the normal DocDrawer, then close this list (one drawer
  // at a time — the Decisions list is a router into the docs, not a peer view alongside them).
  function openAdr(id: string) {
    closeDecisions();
    selectDoc(id);
  }

  return (
    <div
      className="ds-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Decisions"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeDecisions();
      }}
    >
      <div className="ds-panel">
        <div className="ds-bar">
          <div className="ds-titles">
            <div className="ds-kind">Decisions</div>
            <div className="ds-ttl">
              {adrs.length} {adrs.length === 1 ? "ADR" : "ADRs"}
            </div>
          </div>
          <span className="ds-grow" />
          <button className="ds-close" type="button" aria-label="Close" onClick={closeDecisions}>
            ✕
          </button>
        </div>
        {adrs.length === 0 ? (
          <div className="ds-empty">No decisions recorded yet.</div>
        ) : (
          <ul className="ds-list">
            {adrs.map((adr) => {
              const { key, title } = rowView(adr);
              return (
                <li key={adr.id}>
                  <button className="ds-row" type="button" onClick={() => openAdr(adr.id)}>
                    <span className="ds-rk">ADR · {key}</span>
                    <span className="ds-rt">{title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────────────────────────────
// Injected once (co-located so the drawer's styling stays in its owned file). Mirrors DocDrawer's
// overlay-over-dimmed-graph treatment and reads the ui-v2 tokens (tokens.css) for every color — no new palette.
const STYLE_ID = "agentry-decisionsdrawer-styles";
function useDecisionsStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = DS_CSS;
    document.head.appendChild(el);
  }, []);
}

const DS_CSS = `
.ds-overlay{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;
  background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(2px)}
.ds-panel{display:flex;flex-direction:column;width:420px;max-width:100%;min-width:0;
  background:var(--bg);border-left:1px solid var(--line);box-shadow:-8px 0 30px rgba(0,0,0,.4)}

.ds-bar{display:flex;align-items:center;gap:11px;padding:13px 18px;border-bottom:1px solid var(--line);
  background:var(--panel)}
.ds-titles{display:flex;flex-direction:column;gap:2px;min-width:0}
.ds-kind{font:700 10px var(--mono);letter-spacing:1.3px;text-transform:uppercase;color:var(--prog)}
.ds-ttl{font-weight:650;font-size:15px;color:var(--ink)}
.ds-grow{flex:1}
.ds-close{cursor:pointer;color:var(--muted);font-size:13px;background:none;border:0;padding:4px 8px;
  border-radius:var(--r-sm);font-family:var(--sans)}
.ds-close:hover{color:var(--ink);background:var(--hover)}

.ds-list{list-style:none;margin:0;padding:10px;overflow:auto;display:flex;flex-direction:column;gap:6px}
.ds-row{display:flex;flex-direction:column;gap:4px;width:100%;text-align:left;cursor:pointer;
  padding:11px 13px;border:1px solid var(--line2);border-radius:var(--r-lg);background:var(--panel);
  font-family:var(--sans);transition:border-color .14s,background .14s}
.ds-row:hover{border-color:var(--accent-line);background:var(--panel2)}
.ds-rk{font:700 10px var(--mono);letter-spacing:.8px;text-transform:uppercase;color:var(--accent-ink)}
.ds-rt{font-size:13.5px;font-weight:600;color:var(--ink);line-height:1.3}

.ds-empty{padding:30px 18px;color:var(--muted);font-size:12.5px;text-align:center}
`;
