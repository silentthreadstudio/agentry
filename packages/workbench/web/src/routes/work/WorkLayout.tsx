// WorkLayout — the work-level shell for a <id>.localhost host: the run header + the Live / Activity
// tab switcher, with EMPTY tab bodies (this task scaffolds the shell only). The Live tab's Panorama
// graph is Phase 2; the Activity feed is Phase 4. Both render calm "coming in this view" placeholders
// now (empty states are good states, VISION §3). The tab routes are the named slots those phases fill.
import { NavLink, Route, Routes } from "react-router-dom";
import { EmptyState, Pill } from "../../design-system/index.js";

// The run id comes from /api/context (the *.localhost host bootstrap), not the SPA path — App reads
// it once and passes it down. Within the work shell, the routes are only the Live / Activity tabs.
export function WorkLayout({ runId }: { runId: string }) {
  const host = `${runId}.localhost:${location.port || "4317"}`;

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
          <Route index element={<LivePlaceholder />} />
          {/* Phase 4 fills the Activity slot with the event feed. */}
          <Route path="activity" element={<ActivityPlaceholder />} />
        </Routes>
      </div>
    </div>
  );
}

function LivePlaceholder() {
  return (
    <div className="page">
      <EmptyState title="Live">
        The Panorama — the run executing now, as a graph — arrives in this view.
      </EmptyState>
    </div>
  );
}

function ActivityPlaceholder() {
  return (
    <div className="page">
      <EmptyState title="Activity">Everything Agentry has done in this run will stream here.</EmptyState>
    </div>
  );
}
