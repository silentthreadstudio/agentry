// Works home — the bare-localhost landing: every .agentry/work/* run as a card with its status
// tally, roster size, and last-touched time (from GET /api/works → RunSummary[]). Clicking a card
// navigates the browser to that run's host (http://<id>.localhost:<port>) — the *.localhost routing
// decision. Loading / empty / error are all designed (empty states are good states, VISION §3).
import { useEffect, useMemo, useState } from "react";
import type { RunSummary } from "@agentry/workbench-shared";
import { ApiError, fetchWorks } from "../api/client.js";
import { Card, EmptyState, SearchInput, StatusDot } from "../design-system/index.js";
import type { DotStatus, FlowTaskStatus } from "../design-system/index.js";

// The host a run card opens. Same host, same port — only the subdomain changes (bare → <id>).
function runHref(runId: string): string {
  const { protocol, hostname, port } = location;
  // strip any existing run subdomain so we always target <id>.<base-host>
  const baseHost = hostname.replace(/^[^.]+\.(?=localhost$)/, "");
  const host = `${runId}.${baseHost}${port ? `:${port}` : ""}`;
  return `${protocol}//${host}/`;
}

// The card's headline status: the most "live" bucket that has work, so the eye lands on what's moving.
const STATUS_PRIORITY: FlowTaskStatus[] = ["in-progress", "in-review", "todo", "done"];
function primaryStatus(counts: Record<FlowTaskStatus, number>): DotStatus {
  for (const s of STATUS_PRIORITY) {
    if ((counts[s] ?? 0) > 0) return s;
  }
  return "done";
}

const COUNT_ORDER: { key: FlowTaskStatus; label: string }[] = [
  { key: "in-progress", label: "in progress" },
  { key: "in-review", label: "in review" },
  { key: "todo", label: "to do" },
  { key: "done", label: "done" },
];

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; works: RunSummary[] };

export function Works() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [query, setQuery] = useState("");

  useEffect(() => {
    const ctrl = new AbortController();
    fetchWorks(ctrl.signal)
      .then((works) => setState({ kind: "ready", works }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const message =
          err instanceof ApiError
            ? `Couldn’t reach the Workbench server (${err.status}).`
            : "Couldn’t load runs from the Workbench server.";
        setState({ kind: "error", message });
      });
    return () => ctrl.abort();
  }, []);

  const filtered = useMemo(() => {
    if (state.kind !== "ready") return [];
    const q = query.trim().toLowerCase();
    if (!q) return state.works;
    return state.works.filter(
      (w) => w.title.toLowerCase().includes(q) || w.run.toLowerCase().includes(q),
    );
  }, [state, query]);

  return (
    <div className="page">
      {state.kind === "ready" && state.works.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={`Search ${state.works.length} run${state.works.length === 1 ? "" : "s"}…`}
            label="Search runs"
          />
        </div>
      ) : null}

      {state.kind === "loading" ? (
        <EmptyState>Loading runs…</EmptyState>
      ) : state.kind === "error" ? (
        <EmptyState title="Can’t reach the server">{state.message}</EmptyState>
      ) : state.works.length === 0 ? (
        <EmptyState title="No runs yet">
          When Agentry starts a run it lands here. Kick one off with <span className="muted">/agentry:go</span>.
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState title="No matches">Nothing matches “{query}”.</EmptyState>
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
  const total = COUNT_ORDER.reduce((n, c) => n + (work.taskCounts[c.key] ?? 0), 0);
  return (
    <Card
      interactive
      ariaLabel={`Open run ${work.title}`}
      onClick={() => {
        location.href = runHref(work.run);
      }}
    >
      <div className="work-card-top">
        <div style={{ minWidth: 0 }}>
          <div className="work-card-title">{work.title}</div>
          <div className="work-card-run">{work.run}</div>
        </div>
        <span style={{ flex: "none" }}>
          <StatusDot status={status} showLabel />
        </span>
      </div>

      <div className="work-card-counts">
        {COUNT_ORDER.filter((c) => (work.taskCounts[c.key] ?? 0) > 0).map((c) => (
          <span className="count" key={c.key}>
            <StatusDot status={c.key} showLabel={false} />
            <b>{work.taskCounts[c.key]}</b> {c.label}
          </span>
        ))}
        {total === 0 ? <span className="count faint">no tasks yet</span> : null}
      </div>

      <div className="work-card-foot">
        <span>
          {work.agentCount} agent{work.agentCount === 1 ? "" : "s"}
        </span>
        <span className="faint">·</span>
        <span className="faint">{relativeTime(work.updatedAt)}</span>
      </div>
    </Card>
  );
}
