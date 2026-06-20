// WorkLayout — the work-level shell for a <id>.localhost host: the run header + the Live graph / Docs /
// Activity tab switcher. The Live tab is the Panorama graph (Phase 2, the graph stays "home"); the Docs
// tab (task 008) is the multi-doc workspace (navigator ⇄ tabs+editor ⇄ conversation rail); Activity is
// the run's event timeline (Phase 4).
//
// ── The `?doc=` ↔ open-tab sync (task 008, evolved from the BUG-4b drawer sync) ───────────────────────
// A doc opening used to mean a drawer over the graph; it now means a TAB in the Docs workspace. The active
// doc tab is mirrored into a `?doc=` param ON the /docs route so:
//   • the Gates inbox deep-link (<run>.localhost/?doc=<id>) opens that doc on arrival, on the Docs tab;
//   • opening / switching docs is a same-host history entry — Back walks the doc history, never the host;
//   • a refresh re-opens the active doc.
// `selectDoc` (the open signal Panorama / DecisionsDrawer call) writes the tab store; this shell reflects
// that store ⇄ the URL.
import { useEffect, useRef } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Pill } from "../../design-system/index.js";
import { Activity } from "./Activity.js";
import { Panorama } from "./live/Panorama.js";
import { DocsWorkspace } from "./docs/DocsWorkspace.js";
import { selectDoc, useSelectedDoc } from "./docs/doc-tabs.js";

// The current `?doc=` query value (or null) for this host, read from the live URL.
function docParam(): string | null {
  return new URLSearchParams(window.location.search).get("doc");
}

// Build a same-host URL for this host with `?doc=` set (id) or cleared (null), preserving the rest of the
// query + the hash + the path. Pathname-relative — it never re-targets the host.
function urlWithDoc(id: string | null): string {
  const params = new URLSearchParams(window.location.search);
  if (id) params.set("doc", id);
  else params.delete("doc");
  const qs = params.toString();
  return `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
}

export function WorkLayout({ runId }: { runId: string }) {
  const host = `${runId}.localhost:${location.port || "4317"}`;

  const docId = useSelectedDoc();
  const navigate = useNavigate();
  const routerLocation = useLocation();
  // True while a history mutation we just made is settling — so the matching state-sync effect doesn't
  // treat our own pushState/replaceState as a fresh user intent and loop.
  const syncing = useRef(false);

  // ?doc= deep link (the Gates inbox jumps to a doc at its gate via <run>.localhost/?doc=<docId>). On
  // mount, read the param, open that doc's tab (selectDoc) and route to the Docs workspace. `replaceState`
  // rewrites the ENTRY url in place so the arriving `?doc=` becomes the current state and a refresh
  // re-opens the same doc, while Back from here leaves on the bare host (the legit deep-link prior).
  useEffect(() => {
    const initial = docParam();
    if (!initial) return;
    syncing.current = true;
    selectDoc(initial);
    navigate(`/docs${urlWithDocSearch(initial)}`, { replace: true });
    syncing.current = false;
    // run once: the param is the entry intent, not a live source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The active doc tab IS browser history, same-host. Switching/opening a doc updates `?doc=` on the Docs
  // route (a real entry), so Back walks the doc history and keeps you on the run. Only mirror once we're on
  // /docs (a Live-tab node click navigates to /docs first, which lands here with docId set).
  useEffect(() => {
    if (syncing.current) return;
    if (!routerLocation.pathname.startsWith("/docs")) return;
    const current = docParam();
    if (docId === current) return;
    syncing.current = true;
    window.history.pushState({ doc: docId }, "", urlWithDoc(docId));
    syncing.current = false;
  }, [docId, routerLocation.pathname]);

  // Back/Forward (popstate): reconcile the open doc tab to whatever `?doc=` the restored entry carries.
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
            Live graph
          </NavLink>
          <NavLink to="docs" className={({ isActive }) => `tab${isActive ? " on" : ""}`}>
            Docs
          </NavLink>
          <NavLink to="activity" className={({ isActive }) => `tab${isActive ? " on" : ""}`}>
            Activity
          </NavLink>
        </nav>
        <Pill tone="route">{host}</Pill>
      </div>
      <div className="body">
        <Routes>
          {/* The graph stays home on the Live tab. */}
          <Route index element={<Panorama runId={runId} />} />
          {/* Task 008: the multi-doc workspace — the primary doc surface. */}
          <Route path="docs" element={<DocsWorkspace runId={runId} />} />
          {/* Phase 4: this run's event timeline. */}
          <Route path="activity" element={<Activity runId={runId} />} />
        </Routes>
      </div>
    </div>
  );
}

// The `?doc=` search suffix (with the leading `?`) for an id — used when building a router path string
// (where `window.location` may not yet reflect the target route).
function urlWithDocSearch(id: string | null): string {
  const params = new URLSearchParams();
  if (id) params.set("doc", id);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
