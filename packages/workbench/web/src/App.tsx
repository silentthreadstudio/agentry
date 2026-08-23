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
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { fetchContext, fetchProjects, selectProject, type ProjectEntry } from "./api/index.js";
import { getWsClient } from "./api/ws.js";
import { ApprovalsBanner } from "./routes/approvals/ApprovalsBanner.js";
import { Gates } from "./routes/gates/Gates.js";
import { Memory } from "./routes/memory/Memory.js";
import { Board } from "./routes/board/Board.js";
import { WorkLayout } from "./routes/work/WorkLayout.js";
import { runHref } from "./routes/works/works-view.js";

import "./ui/tokens.css";
import "./App.css";

// The sidebar nav — Works / Memory / Gates only (Agents/Tokens removed). `ic` is a monochrome glyph
// (text, not an icon set); the active state's gradient pill + left bar are CSS (.nav.on).
const NAV: { to: string; ic: string; label: string }[] = [
  { to: "/", ic: "▦", label: "Board" },
  { to: "/memory", ic: "✦", label: "Memory" },
  { to: "/gates", ic: "◈", label: "Gates" },
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

// The routed shell. Split out of `App` only so it can call `useLocation` (which must run inside the
// router): the run view manages its own scrolling and full-height canvas, so `.body`'s page padding is
// dropped for it via the `flush` modifier rather than being fought inside the run layout.
function Shell({ project, aliasTarget }: { project: string | undefined; aliasTarget: string | undefined }) {
  const onWork = useLocation().pathname.startsWith("/work/");

  // The run view supplies its OWN `.main` (top bar + tabs + a full-height body its React Flow canvas
  // fills), so it is mounted as a direct child of the `.app` grid rather than nested inside the page
  // shell's `.main > .body`. Nesting it there gave the inner column no height and the canvas rendered
  // 0px — the same "run link loads nothing" symptom the old separate-origin `.solo` wrapper existed to
  // avoid. The sidebar stays mounted either way: that is what path routing buys.
  return (
    <div className="app">
      <Sidebar project={project} />
      {onWork ? (
        <Routes>
          <Route path="/work/:slug/*" element={<WorkRoute />} />
        </Routes>
      ) : (
        <main className="main">
          <div className="body">
            <Routes>
              <Route path="/" element={aliasTarget ? <Navigate to={aliasTarget} replace /> : <Board />} />
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
      )}
      {/* The approvals overlay is project-global and time-sensitive, so it floats over every route —
          a tool may need approval while you are on a secondary page rather than inside a run. */}
      <ApprovalsBanner />
    </div>
  );
}

// One run, addressed by its `/work/<slug>` path segment. The slug is resolved to the FULL run id before
// the layout mounts, because everything downstream (ws subscription keys, doc ids, write routes) is
// keyed by the full id. An unresolvable slug is a dead link, not a crash — say so and offer the way back.
function WorkRoute() {
  const slug = useParams().slug ?? "";
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ready"; run: string | undefined }>({
    kind: "loading",
  });

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ kind: "loading" });
    fetchContext(slug, ctrl.signal)
      .then((ctx) => setState({ kind: "ready", run: ctx.run }))
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ kind: "ready", run: undefined });
      });
    return () => ctrl.abort();
  }, [slug]);

  // The socket outlives route changes (the approvals banner keeps a subscriber alive), so moving between
  // runs must re-point it — otherwise the new run's live updates never arrive.
  useEffect(() => {
    getWsClient().retarget();
  }, [slug]);

  if (state.kind === "loading") return <main className="main" aria-busy="true" />;
  if (state.run === undefined) {
    return (
      <main className="main">
        <div className="body">
          <h1>Run not found</h1>
          <p className="muted">
            No run matches <code>{slug}</code> in this project. <a href="/">Back to Works</a>
          </p>
        </div>
      </main>
    );
  }
  return <WorkLayout runId={state.run} />;
}

function Sidebar({ project }: { project: string | undefined }) {
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
      <ProjectCard project={project} />
    </aside>
  );
}

// The project card, and the switcher when this server serves more than one root. Which project is on
// screen used to be a hardcoded string, which lied whenever the server had been started from another
// repo — the port is a global singleton, the root is not. It now names what the server reports, and lets
// you move between the registered projects.
//
// Switching does a full page load on purpose. It is a rare, deliberate action, and every open view holds
// per-project state (the run list, a graph, an open doc, the socket); reloading is the honest way to drop
// all of it at once rather than teaching each view to re-key itself.
function ProjectCard({ project }: { project: string | undefined }) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchProjects(ctrl.signal)
      .then((list) => setProjects(list.projects))
      .catch(() => {
        /* older server, or none — the card still names the current project */
      });
    return () => ctrl.abort();
  }, []);

  const onSwitch = (slug: string) => {
    if (slug === project) return;
    selectProject(slug);
    window.location.assign("/");
  };

  return (
    <div className="proj">
      <div className="k">Project</div>
      {projects.length > 1 ? (
        <select
          className="n proj-switch"
          aria-label="Switch project"
          value={project ?? ""}
          onChange={(e) => onSwitch(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.slug} value={p.slug} title={p.root}>
              {p.slug}
            </option>
          ))}
        </select>
      ) : (
        <div className="n">{project ?? "workspace"}</div>
      )}
      <div className="row">
        <span className="livedot" aria-hidden="true" /> server live
      </div>
    </div>
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
