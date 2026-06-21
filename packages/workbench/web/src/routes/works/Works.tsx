// Works home — the bare-localhost landing (UI-v2 "expressive" language, design/ui-v2.html): a gradient
// hero, four KPI metric tiles derived from /api/works, a section bar with a segmented filter, and a grid
// of expressive run cards (status-tinted aura, badges, progress, agent avatar). Clicking a card navigates
// the browser to that run's short host (http://<workSlug>.localhost:<port>) — the *.localhost short-URL
// decision. Loading / empty / error are all designed (empty states are good states, VISION §3).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RunSummary } from "@agentry/workbench-shared";
import { ApiError, fetchWorks } from "../../api/index.js";
import { getWsClient } from "../../api/ws.js";
import { Card, EmptyState, SearchInput, StatusDot } from "../../ui/index.js";
import {
  AURA_HUE,
  COUNT_ORDER,
  FILTERS,
  deriveKpis,
  isActiveRun,
  primaryStatus,
  relativeTime,
  runHref,
  runInitials,
  tasksTotal,
  type WorksFilter,
} from "./works-view.js";

import "./works.css";

// The route's own load state machine (component-local — the derivations/formatters live in works-view).
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; works: RunSummary[] };

export function Works() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WorksFilter>("all");

  // Load the works list — reused for the initial fetch and every live refetch. `quiet` (a live refetch)
  // keeps the current list on failure instead of flipping the whole page to an error state, and never resets
  // to "loading", so a refresh updates in place with no flash.
  const load = useCallback((signal: AbortSignal, quiet = false) => {
    fetchWorks(signal)
      .then((works) => setState({ kind: "ready", works }))
      .catch((err: unknown) => {
        if (signal.aborted || quiet) return;
        const message =
          err instanceof ApiError
            ? `Couldn’t reach the Workbench server (${err.status}).`
            : "Couldn’t load runs from the Workbench server.";
        setState({ kind: "error", message });
      });
  }, []);

  // Initial load.
  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Live (task #1): the server pushes `works-changed` (project-global) whenever the work tree moves — a new
  // run folder, a status flip, an updatedAt bump. Refetch the list (debounced) so the home goes live with no
  // reload: new runs appear, tallies re-tint. Best-effort (`quiet`) — a transient refetch failure keeps the
  // shown list rather than clobbering it.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ctrl: AbortController | null = null;
    const off = getWsClient().subscribe((msg) => {
      if (msg.type !== "works-changed" || timer) return;
      timer = setTimeout(() => {
        timer = null;
        ctrl?.abort();
        ctrl = new AbortController();
        load(ctrl.signal, true);
      }, 250);
    });
    return () => {
      if (timer) clearTimeout(timer);
      ctrl?.abort();
      off();
    };
  }, [load]);

  const works = state.kind === "ready" ? state.works : [];
  const kpis = useMemo(() => deriveKpis(works), [works]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return works
      .filter((w) => (filter === "all" ? true : filter === "active" ? isActiveRun(w) : !isActiveRun(w)))
      .filter((w) => !q || w.title.toLowerCase().includes(q) || w.run.toLowerCase().includes(q));
  }, [works, query, filter]);

  return (
    <div className="works">
      <div className="hero">
        <div>
          <h1>Works</h1>
          <p>Every run in the project — read, steer, and ship the work the agents are doing.</p>
        </div>
        <div className="grow" />
        {state.kind === "ready" && works.length > 0 ? (
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={`Search ${works.length} run${works.length === 1 ? "" : "s"}…`}
            label="Search runs"
          />
        ) : null}
      </div>

      {state.kind === "ready" && works.length > 0 ? (
        <div className="metrics">
          <div className="kpi">
            <div className="glow" style={{ background: "var(--v1)" }} />
            <div className="k">Active runs</div>
            <div className="v">
              {kpis.activeRuns} <small>/ {kpis.totalRuns}</small>
            </div>
            <div className="trend">{kpis.totalRuns} total</div>
          </div>
          <div className="kpi">
            <div className="glow" style={{ background: "var(--prog)" }} />
            <div className="k">In progress</div>
            <div className="v" style={{ color: "var(--prog)" }}>
              {kpis.inProgress}
            </div>
            <div className="trend">tasks moving</div>
          </div>
          <div className="kpi">
            <div className="glow" style={{ background: "var(--v2)" }} />
            <div className="k">Agents live</div>
            <div className="v" style={{ color: "var(--v2)" }}>
              {kpis.agentsLive}
            </div>
            <div className="trend">in the roster</div>
          </div>
          <div className="kpi">
            <div className="glow" style={{ background: "var(--done)" }} />
            <div className="k">Throughput</div>
            <div className="v" style={{ color: "var(--done)" }}>
              {kpis.pctDone}
              <small>% done</small>
            </div>
            <div className="trend">across all tasks</div>
          </div>
        </div>
      ) : null}

      {state.kind === "ready" && works.length > 0 ? (
        <div className="sec">
          <h2>Runs</h2>
          <span className="pillct">{works.length}</span>
          <div className="seg" role="tablist" aria-label="Filter runs">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                className={filter === f.key ? "on" : ""}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {state.kind === "loading" ? (
        <EmptyState>Loading runs…</EmptyState>
      ) : state.kind === "error" ? (
        <EmptyState title="Can’t reach the server">{state.message}</EmptyState>
      ) : works.length === 0 ? (
        <EmptyState title="No runs yet">
          When Agentry starts a run it lands here. Kick one off with <span className="muted">/agentry:go</span>.
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState title="No matches">
          {query ? <>Nothing matches “{query}”.</> : "No runs in this filter."}
        </EmptyState>
      ) : (
        <div className="works-grid">
          {filtered.map((w) => (
            <WorkCard key={w.run} work={w} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkCard({ work }: { work: RunSummary }) {
  const status = primaryStatus(work.taskCounts);
  const total = tasksTotal(work.taskCounts);
  const done = work.taskCounts.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const counts = COUNT_ORDER.filter((c) => (work.taskCounts[c.key] ?? 0) > 0);
  return (
    <Card
      interactive
      className="work-card"
      ariaLabel={`Open run ${work.title}`}
      onClick={() => {
        location.href = runHref(work.run);
      }}
      // override the Card primitive's flat --panel BASE with the expressive gradient surface (inline
      // wins over the .work-card class; the rest of the card's layout lives in components.css).
      style={{
        background: "linear-gradient(180deg, #16161e, #101015)",
        borderRadius: 18,
        padding: "19px 20px",
      }}
    >
      <div className="work-card-aura" aria-hidden="true" style={{ background: AURA_HUE[status] }} />

      <div className="work-card-top">
        <div style={{ minWidth: 0 }}>
          <div className="work-card-title">{work.title}</div>
          <div className="work-card-run">{work.run}</div>
        </div>
        <span style={{ flex: "none" }}>
          <StatusDot status={status} showLabel />
        </span>
      </div>

      {work.shape || work.kind ? (
        <div className="work-card-badges">
          {work.shape ? <span className="work-badge accent">{work.shape}</span> : null}
          {work.kind ? <span className="work-badge">{work.kind}</span> : null}
        </div>
      ) : null}

      {work.summary ? <p className="work-card-summary">{work.summary}</p> : null}

      <div className="work-card-progress">
        <div className="work-card-barwrap">
          <div className="work-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <span className="work-pctn">{pct}%</span>
        </div>
        <div className="work-card-foot">
          {counts.length > 0 ? (
            <div className="work-card-counts">
              {counts.map((c) => (
                <span className="count" key={c.key}>
                  <StatusDot status={c.key} showLabel={false} />
                  <b>{work.taskCounts[c.key]}</b> {c.label}
                </span>
              ))}
            </div>
          ) : (
            <span className="count faint">no tasks yet</span>
          )}
          <span className="grow" />
          <span className="work-ava" aria-hidden="true">
            {runInitials(work.run)}
          </span>
          <span className="faint">· {relativeTime(work.updatedAt)}</span>
        </div>
      </div>
    </Card>
  );
}
