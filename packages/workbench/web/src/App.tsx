// The Workbench app shell — the UI-v2 "Agent Center" language (design/ui-v2.html): a 248px sidebar
// (text-only "Agentry Center" wordmark · Works/Memory/Gates nav with counts · live-server project card)
// + a main column the routes fill over the fixed mesh-gradient background. *.localhost routing
// (decided): the SPA reads /api/context to learn whether this host is a run (<id>.localhost → the
// WorkLayout with Live/Activity) or the bare host (Works home + secondary pages).
import { useEffect, useState } from "react";
import { BrowserRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { fetchContext } from "./api/index.js";
import { ApprovalsBanner } from "./routes/ApprovalsBanner.js";
import { Gates } from "./routes/Gates.js";
import { Memory } from "./routes/Memory.js";
import { Works } from "./routes/Works.js";
import { WorkLayout } from "./routes/work/WorkLayout.js";

import "./ui/tokens.css";
import "./App.css";

// The sidebar nav — Works / Memory / Gates only (Agents/Tokens removed). `ic` is a monochrome glyph
// (text, not an icon set); the active state's gradient pill + left bar are CSS (.nav.on).
const NAV: { to: string; ic: string; label: string }[] = [
  { to: "/", ic: "◳", label: "Works" },
  { to: "/memory", ic: "✦", label: "Memory" },
  { to: "/gates", ic: "◈", label: "Gates" },
];

type Boot =
  | { kind: "loading" }
  | { kind: "ready"; run: string | undefined };

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    fetchContext(ctrl.signal)
      .then((ctx) => setBoot({ kind: "ready", run: ctx.run }))
      // No server yet (or bare host): fall back to the Works home rather than blocking the UI.
      .catch(() => {
        if (!ctrl.signal.aborted) setBoot({ kind: "ready", run: undefined });
      });
    return () => ctrl.abort();
  }, []);

  if (boot.kind === "loading") {
    // brief, calm boot — no spinner flash for a local server that answers in <50ms
    return <div className="app" aria-busy="true" />;
  }

  // A run host (<id>.localhost) goes straight to that run's work shell; tabs route under it.
  // The `.solo` wrapper gives the work shell a full-height (100vh) flex context — WITHOUT it the
  // bare `.main` collapses to content height and the React Flow canvas (height:100%) renders 0px
  // (the "run link loads nothing" bug). The bare host gets its height from the `.app` grid instead.
  if (boot.run) {
    return (
      <BrowserRouter>
        <div className="solo">
          <Routes>
            <Route path="/*" element={<WorkLayout runId={boot.run} />} />
          </Routes>
        </div>
        {/* The approvals banner floats over the run shell (a fixed overlay) — permission prompts are
            project-global and time-sensitive, so it appears regardless of the active tab. */}
        <ApprovalsBanner />
      </BrowserRouter>
    );
  }

  // The bare host: the sidebar shell with Works home + the scaffolded secondary pages. Each route
  // owns its own hero (the gradient-clipped H1 + subtitle); the body just supplies padding + scroll.
  return (
    <BrowserRouter>
      <div className="app">
        <Sidebar />
        <main className="main">
          <div className="body">
            <Routes>
              <Route path="/" element={<Works />} />
              <Route
                path="/memory"
                element={
                  <PageHero title="Memory" sub="The moat — durable facts and episodes, read-only.">
                    <Memory />
                  </PageHero>
                }
              />
              <Route
                path="/gates"
                element={
                  <PageHero title="Gates" sub="Decisions waiting on you.">
                    <Gates />
                  </PageHero>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
        {/* Same global approvals overlay on the bare host (Works / Memory / Gates) — a tool may need
            approval while the user is on a secondary page, not inside a run. */}
        <ApprovalsBanner />
      </div>
    </BrowserRouter>
  );
}

function Sidebar() {
  return (
    <aside className="side">
      <div className="brand">
        <div className="wm">
          <b>Agentry Center</b>
          <i>workbench</i>
        </div>
      </div>
      <div className="seclbl">Workspace</div>
      <nav aria-label="Primary">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === "/"}
            className={({ isActive }) => `nav${isActive ? " on" : ""}`}
          >
            <span className="ic" aria-hidden="true">
              {n.ic}
            </span>
            {n.label}
          </NavLink>
        ))}
      </nav>
      <div className="grow" />
      <div className="proj">
        <div className="k">Project</div>
        <div className="n">agentry</div>
        <div className="row">
          <span className="livedot" aria-hidden="true" /> server live
        </div>
      </div>
    </aside>
  );
}

// A lightweight hero for the secondary pages (Memory/Gates) — the gradient-clipped title + subtitle
// matching the Works hero, without the search/new-run controls those pages don't need.
function PageHero({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="hero">
        <div>
          <h1>{title}</h1>
          <p>{sub}</p>
        </div>
        <div className="grow" />
      </div>
      {children}
    </>
  );
}
