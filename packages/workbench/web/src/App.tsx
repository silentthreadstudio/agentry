// The Workbench app shell — the UI-v2 "Agent Center" language (design/ui-v2.html): a 248px sidebar
// (text-only "Agentry Center" wordmark · Works/Memory/Gates nav with counts · live-server project card)
// + a main column the routes fill over the fixed mesh-gradient background.
//
// Routing is PATH-based: `/` is the Works home and `/work/<slug>` is a run, both under ONE origin, so
// moving between runs is client-side navigation — no reload, no second WebSocket, no per-run storage
// bucket. The `<slug>.localhost` form still resolves (the server 302s it to the path), and a run that
// arrives via `/api/context` anyway is forwarded to its canonical path below.
//
// `/api/context` is still read once at boot, but now for the PROJECT: the fixed port is a global
// singleton while the project root is per-process, so the sidebar must name the project the server is
// actually serving instead of a hardcoded string.
import { useEffect, useState } from "react";
import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import type { BoardCard } from "@agentry/workbench-shared";
import { fetchBoard, fetchContext } from "./api/index.js";
import { getWsClient } from "./api/ws.js";
import { ApprovalsBanner } from "./routes/approvals/ApprovalsBanner.js";
import { ConductorRail } from "./routes/rail/ConductorRail.js";
import { OnShift } from "./routes/shell/OnShift.js";
import { ProjectSwitcher } from "./routes/shell/ProjectSwitcher.js";
import { useWorkspaceCounts, type WorkspaceCounts } from "./routes/shell/workspace-counts.js";
import { Gates } from "./routes/gates/Gates.js";
import { Memory } from "./routes/memory/Memory.js";
import { Board } from "./routes/board/Board.js";
import { RunView } from "./routes/board/RunView.js";
import { runHref } from "./routes/board/board-view.js";
import { focusRun } from "./routes/rail/rail-state.js";
import { Backlog } from "./routes/shell/Backlog.js";
import { Projects } from "./routes/shell/Projects.js";
import { Settings } from "./routes/shell/Settings.js";

import "./ui/tokens.css";
import "./App.css";

// The sidebar's two sections. `ic` is a monochrome glyph (text, not an icon set); the active state's
// gradient pill + left bar are CSS (.nav.on). `count` names which workspace number rides beside the
// entry — the counts are the point, not decoration: "Gates 2" tells you something is waiting without
// making you open the page to find out.
type NavItem = { to: string; ic: string; label: string; count?: keyof WorkspaceCounts };

const PROJECT_NAV: NavItem[] = [
  { to: "/", ic: "▦", label: "Board", count: "board" },
  { to: "/backlog", ic: "≡", label: "Backlog", count: "backlog" },
  { to: "/gates", ic: "◈", label: "Gates", count: "gates" },
  { to: "/memory", ic: "✦", label: "Memory", count: "memory" },
];

const WORKSPACE_NAV: NavItem[] = [
  { to: "/projects", ic: "◳", label: "All projects", count: "projects" },
  { to: "/settings", ic: "⚙", label: "Settings" },
];

type Boot =
  | { kind: "loading" }
  | { kind: "ready"; project: string | undefined; aliasRun: string | undefined };

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    fetchContext(undefined, ctrl.signal)
      .then((ctx) => setBoot({ kind: "ready", project: ctx.project, aliasRun: ctx.run }))
      // No server yet: fall back to the Works home rather than blocking the UI.
      .catch(() => {
        if (!ctrl.signal.aborted) setBoot({ kind: "ready", project: undefined, aliasRun: undefined });
      });
    return () => ctrl.abort();
  }, []);

  if (boot.kind === "loading") {
    // brief, calm boot — no spinner flash for a local server that answers in <50ms
    return <div className="app" aria-busy="true" />;
  }

  // A `<slug>.localhost` alias page that reached the SPA without being redirected (a deep asset path,
  // say) is forwarded to its canonical path once React is up — one origin from here on.
  const aliasTarget =
    boot.aliasRun !== undefined && !window.location.pathname.startsWith("/work/")
      ? runHref(boot.aliasRun)
      : undefined;

  // One shell for everything: Works home, the secondary pages, AND a run. Keeping the sidebar mounted
  // over a run is the point of path routing — you can leave a run (or hop to another) without a reload.
  return (
    <BrowserRouter>
      <Shell project={boot.project} aliasTarget={aliasTarget} />
    </BrowserRouter>
  );
}

// The routed shell — split out of `App` only so it can use the router's hooks.
function Shell({ project, aliasTarget }: { project: string | undefined; aliasTarget: string | undefined }) {
  // One shell, one column. The run VIEW is gone: `/work/<slug>` is the board with that run's pane open,
  // so a link into a run no longer takes you away from the board or from the conversation about it.
  return (
    <div className="app">
      <Sidebar project={project} />
      <main className="main">
        <div className="body">
          <Routes>
            <Route path="/" element={aliasTarget ? <Navigate to={aliasTarget} replace /> : <Board />} />
            <Route path="/work/:slug/*" element={<RunRoute />} />
            <Route
              path="/backlog"
              element={
                <PageHero title="Backlog" sub="Captured, not started — read it, then queue what is next.">
                  <Backlog />
                </PageHero>
              }
            />
            <Route
              path="/projects"
              element={
                <PageHero title="All projects" sub="Every root this server is serving.">
                  <Projects current={project} />
                </PageHero>
              }
            />
            <Route
              path="/settings"
              element={
                <PageHero title="Settings" sub="What this workspace is, and where to change it.">
                  <Settings />
                </PageHero>
              }
            />
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

      {/* The conversation is AMBIENT: a column beside the work, not a page you navigate to. */}
      <ConductorRail />
      {/* The approvals overlay is project-global and time-sensitive, so it floats over every route. */}
      <ApprovalsBanner />
    </div>
  );
}

/** `/work/<slug>` — the run fills the WORK COLUMN, with the conversation still live beside it.
 *
 *  This is the second of the workspace's two columns switching its content, not a new screen: the
 *  sidebar and the conversation are untouched, so opening a ticket to review it does not cost you the
 *  thread you were having about it. */
function RunRoute() {
  const slug = useParams().slug ?? "";
  const navigate = useNavigate();
  const [card, setCard] = useState<BoardCard | null>(null);

  // The card carries the title and column the header shows. Resolved from the board's own read-model so
  // there is ONE definition of what a card is; a slug that matches nothing still opens (the documents
  // are addressed by slug server-side) with a minimal header rather than an error page.
  useEffect(() => {
    const ctrl = new AbortController();
    fetchBoard(ctrl.signal)
      .then((board) => {
        const match = Object.values(board.columns)
          .flat()
          .find((c) => c.run !== undefined && runHref(c.run).endsWith(`/${slug}`));
        setCard(match ?? { id: slug, column: "running", title: slug, origin: "run", run: slug, updatedAt: "" });
      })
      .catch(() => setCard({ id: slug, column: "running", title: slug, origin: "run", run: slug, updatedAt: "" }));
    return () => ctrl.abort();
  }, [slug]);

  // Opening a run focuses the conversation on it, so the rail follows what you are reviewing.
  useEffect(() => {
    if (card?.run) focusRun(card.run);
  }, [card]);

  if (card === null) return <div aria-busy="true" />;
  return <RunView card={card} onClose={() => navigate("/")} />;
}

function Sidebar({ project }: { project: string | undefined }) {
  const counts = useWorkspaceCounts();
  return (
    <aside className="side">
      <div className="brand">
        <div className="wm">
          <b>Agentry</b>
          <i>workspace</i>
        </div>
      </div>

      {/* The project selector sits at the TOP, where you look first: which workspace am I in? */}
      <ProjectSwitcher current={project} />

      <div className="seclbl">Project</div>
      <Nav items={PROJECT_NAV} counts={counts} />

      <div className="seclbl">Workspace</div>
      <Nav items={WORKSPACE_NAV} counts={counts} />

      <div className="grow" />
      <OnShift />
    </aside>
  );
}

function Nav({ items, counts }: { items: NavItem[]; counts: WorkspaceCounts }) {
  return (
    <nav aria-label="Primary">
      {items.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => `nav${isActive ? " on" : ""}`}>
          <span className="ic" aria-hidden="true">
            {n.ic}
          </span>
          {n.label}
          {n.count !== undefined && counts[n.count] > 0 ? <span className="ct">{counts[n.count]}</span> : null}
        </NavLink>
      ))}
    </nav>
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
