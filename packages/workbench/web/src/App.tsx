// The Workbench app shell — promotes the Phase-0 placeholder to the real router. Structure mirrors
// design/prototype-app.html: a 212px sidebar (logo · nav · active-run card) + a main column the
// routes fill. *.localhost routing (decided): the SPA reads /api/context to learn whether this host
// is a run (<id>.localhost → the WorkLayout with Live/Activity) or the bare host (Works home +
// secondary pages). The sidebar's nav and the work tabs are the named slots Phase 2/4 fill.
import { useEffect, useState } from "react";
import { BrowserRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { fetchContext } from "./api/client.js";
import { Agents } from "./routes/Agents.js";
import { Gates } from "./routes/Gates.js";
import { Memory } from "./routes/Memory.js";
import { Tokens } from "./routes/Tokens.js";
import { Works } from "./routes/Works.js";
import { WorkLayout } from "./routes/work/WorkLayout.js";

import "./design-system/tokens.css";
import "./design-system/components.css";

// The sidebar nav — matches the prototype's order. `to` is the route; `ic` is the prototype's
// monochrome glyph (text, not an icon set — "no icon noise"). Secondary pages are scaffolded.
const NAV: { to: string; ic: string; label: string }[] = [
  { to: "/", ic: "▦", label: "Works" },
  { to: "/agents", ic: "◇", label: "Agents" },
  { to: "/tokens", ic: "▣", label: "Tokens" },
  { to: "/memory", ic: "✦", label: "Memory" },
  { to: "/gates", ic: "◆", label: "Gates" },
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
  if (boot.run) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/*" element={<WorkLayout runId={boot.run} />} />
        </Routes>
      </BrowserRouter>
    );
  }

  // The bare host: the sidebar shell with Works home + the scaffolded secondary pages.
  return (
    <BrowserRouter>
      <div className="app">
        <Sidebar />
        <Routes>
          <Route path="/" element={<MainColumn title="Works" sub="every run, at a glance"><Works /></MainColumn>} />
          <Route
            path="/agents"
            element={
              <MainColumn title="Agents" sub="the roster, live">
                <Agents />
              </MainColumn>
            }
          />
          <Route
            path="/tokens"
            element={
              <MainColumn title="Tokens" sub="usage & cost">
                <Tokens />
              </MainColumn>
            }
          />
          <Route
            path="/memory"
            element={
              <MainColumn title="Memory" sub="the moat — read-only">
                <Memory />
              </MainColumn>
            }
          />
          <Route
            path="/gates"
            element={
              <MainColumn title="Gates" sub="waiting on you">
                <Gates />
              </MainColumn>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

function Sidebar() {
  return (
    <div className="side">
      <div className="logo">
        <span className="m">a</span>
        <b>Agent Center</b>
      </div>
      <div className="navlbl">Project · agentry</div>
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
    </div>
  );
}

function MainColumn({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div className="main">
      <div className="head">
        <h1>{title}</h1>
        <span className="sub">{sub}</span>
        <span className="grow" />
      </div>
      <div className="body">{children}</div>
    </div>
  );
}
