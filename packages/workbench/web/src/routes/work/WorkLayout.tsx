// WorkLayout — the work-level shell for a <id>.localhost host: the run header + the Live / Activity
// tab switcher, with EMPTY tab bodies (this task scaffolds the shell only). The Live tab's Panorama
// graph is Phase 2; the Activity feed is Phase 4. Both render calm "coming in this view" placeholders
// now (empty states are good states, VISION §3). The tab routes are the named slots those phases fill.
import { useEffect, useRef } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { Pill } from "../../design-system/index.js";
import { Activity } from "./Activity.js";
import { Panorama } from "./live/Panorama.js";
import { selectDoc, useSelectedDoc } from "./live/doc/DocDrawer.js";

// The current `?doc=` query value (or null) for this host, read from the live URL. The drawer mirrors its
// open/close into this single param so opening a doc is an in-app, SAME-HOST history entry (BUG 4b): Back
// closes the drawer / stays on the run host, it never jumps to the bare host.
function docParam(): string | null {
  return new URLSearchParams(window.location.search).get("doc");
}

// Build a same-host URL for this host with `?doc=` set (id) or cleared (null), preserving the rest of the
// query + the hash + the path. CRUCIALLY relative (pathname-based) — it never re-targets the host, so the
// browser stays on <run>.localhost and no cross-host entry is pushed.
function urlWithDoc(id: string | null): string {
  const params = new URLSearchParams(window.location.search);
  if (id) params.set("doc", id);
  else params.delete("doc");
  const qs = params.toString();
  return `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
}

// The run id comes from /api/context (the *.localhost host bootstrap), not the SPA path — App reads
// it once and passes it down. Within the work shell, the routes are only the Live / Activity tabs.
export function WorkLayout({ runId }: { runId: string }) {
  const host = `${runId}.localhost:${location.port || "4317"}`;

  const docId = useSelectedDoc();
  // True while a history mutation we just made is settling — so the matching state-sync effect doesn't
  // treat our own pushState/replaceState as a fresh user intent and loop.
  const syncing = useRef(false);

  // ?doc= deep link (task 23 → task 27): the Gates inbox jumps to a doc at its gate via
  // <run>.localhost/?doc=<docId>. On mount, read the param and open that doc's drawer (selectDoc is the
  // drawer's open contract; the drawer lives on the Live tab's Panorama). `replaceState` rewrites the
  // ENTRY url (in place — no extra entry) so the arriving `?doc=` becomes the current run-host state and a
  // refresh re-opens the same doc, while Back from here leaves on the bare host (the legit deep-link prior).
  useEffect(() => {
    const initial = docParam();
    if (!initial) return;
    syncing.current = true;
    selectDoc(initial);
    window.history.replaceState({ doc: initial }, "", urlWithDoc(initial));
    syncing.current = false;
    // run once: the param is the entry intent, not a live source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // BUG 4b — the drawer's open/close IS browser history, same-host. Opening a doc PUSHES a `?doc=` entry
  // on THIS host (never a cross-host URL — urlWithDoc is pathname-relative); closing it (or switching docs)
  // updates the url. Because the open is a real history entry, the browser Back button now CLOSES the
  // drawer and keeps you on the run, instead of falling through to the bare host. Node clicks reach here
  // only through selectDoc (the gated Panorama handler), so they too stay same-host.
  useEffect(() => {
    if (syncing.current) return; // this change came from a history event we're already reconciling
    const current = docParam();
    if (docId === current) return; // url already reflects the drawer state — nothing to push
    syncing.current = true;
    if (docId) window.history.pushState({ doc: docId }, "", urlWithDoc(docId));
    else window.history.pushState({ doc: null }, "", urlWithDoc(null));
    syncing.current = false;
  }, [docId]);

  // Back/Forward (popstate): reconcile the drawer to whatever `?doc=` the restored history entry carries.
  // Pressing Back after opening a doc lands on the prior run-host entry (no `?doc=`) → the drawer closes,
  // the canvas stays put. This is what makes Back "stay on the run" rather than leave the host (BUG 4b).
  useEffect(() => {
    function onPop() {
      syncing.current = true;
      selectDoc(docParam());
      syncing.current = false;
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return (
    <div className="main">
      <div className="head">
        <h1>{runId || "run"}</h1>
        <span className="sub">the run</span>
        <span className="grow" />
        <nav className="tabs" aria-label="Work views">
          <NavLink end to="" className={({ isActive }) => `tab${isActive ? " on" : ""}`}>
            Live
          </NavLink>
          <NavLink to="activity" className={({ isActive }) => `tab${isActive ? " on" : ""}`}>
            Activity
          </NavLink>
        </nav>
        <Pill tone="route">{host}</Pill>
      </div>
      <div className="body">
        <Routes>
          {/* Phase 2 fills the Live slot with the Panorama graph canvas. */}
          <Route index element={<Panorama runId={runId} />} />
          {/* Phase 4 fills the Activity slot with this run's event timeline. */}
          <Route path="activity" element={<Activity runId={runId} />} />
        </Routes>
      </div>
    </div>
  );
}
