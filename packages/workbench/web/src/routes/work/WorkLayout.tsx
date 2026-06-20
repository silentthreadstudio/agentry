// WorkLayout — the work-level shell for a <id>.localhost host: the run header + the Live / Activity
// tab switcher, with EMPTY tab bodies (this task scaffolds the shell only). The Live tab's Panorama
// graph is Phase 2; the Activity feed is Phase 4. Both render calm "coming in this view" placeholders
// now (empty states are good states, VISION §3). The tab routes are the named slots those phases fill.
import { useEffect } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { Pill } from "../../design-system/index.js";
import { Activity } from "./Activity.js";
import { Panorama } from "./live/Panorama.js";
import { selectDoc } from "./live/doc/DocDrawer.js";

// The run id comes from /api/context (the *.localhost host bootstrap), not the SPA path — App reads
// it once and passes it down. Within the work shell, the routes are only the Live / Activity tabs.
export function WorkLayout({ runId }: { runId: string }) {
  const host = `${runId}.localhost:${location.port || "4317"}`;

  // ?doc= deep link (task 23 → task 27): the Gates inbox jumps to a doc at its gate via
  // <run>.localhost/?doc=<docId>. On mount, read the param and open that doc's drawer (selectDoc is the
  // drawer's open contract; the drawer lives on the Live tab's Panorama). Read once — the param is the
  // entry intent, not a live source of truth; clearing it from the URL keeps a refresh from re-opening.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const docId = params.get("doc");
    if (!docId) return;
    selectDoc(docId);
    params.delete("doc");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
    );
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
