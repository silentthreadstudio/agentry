// Activity — this work's event timeline (the WorkLayout Activity tab). Consumes GET /api/events?run=<id>
// → EventView[] (task 20's one fold, filtered to this run) and renders it as the prototype's calm vertical
// timeline: a day-grouped list of routing-decision → gate → node-enter/node-done events, each with a
// monochrome glyph, a one-line headline, a muted detail, and (for node-done) the duration. Dark + calm
// (AC8); empty / loading / error are all good states (VISION §3). Read-only — a projection, never a write.
// The view-model (EventView → TimelineRow) + the formatters + the inline styles live in `activity-view`.
import { useEffect, useMemo, useState } from "react";
import type { EventView } from "@agentry/workbench-shared";
import { ApiError, fetchEvents } from "../../api/index.js";
import { EmptyState } from "../../ui/index.js";
import {
  DAYLBL,
  EV,
  EV_DETAIL,
  EV_ICON,
  EV_TIME,
  groupByDay,
  toRow,
  type TimelineRow,
} from "./activity-view.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; events: EventView[] };

export function Activity({ runId }: { runId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    fetchEvents(runId, ctrl.signal)
      .then((events) => setState({ kind: "ready", events }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const message =
          err instanceof ApiError
            ? `Couldn’t load this run’s activity (${err.status}).`
            : "Couldn’t load this run’s activity.";
        setState({ kind: "error", message });
      });
    return () => ctrl.abort();
  }, [runId]);

  const groups = useMemo(() => {
    if (state.kind !== "ready") return [];
    return groupByDay(state.events.map(toRow));
  }, [state]);

  return (
    <div className="page">
      {state.kind === "loading" ? (
        <EmptyState>Loading activity…</EmptyState>
      ) : state.kind === "error" ? (
        <EmptyState title="Can’t reach the server">{state.message}</EmptyState>
      ) : state.events.length === 0 ? (
        <EmptyState title="Nothing yet">
          Everything Agentry does in this run will stream here — routing, gates, and each node as it runs.
        </EmptyState>
      ) : (
        groups.map((g) => (
          <div key={g.day}>
            <div style={DAYLBL}>{g.day}</div>
            {g.rows.map((row) => (
              <EventRow key={row.id} row={row} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function EventRow({ row }: { row: TimelineRow }) {
  return (
    <div style={EV}>
      <span style={EV_TIME}>{row.clock}</span>
      <span style={EV_ICON} aria-hidden="true">
        {row.glyph}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5 }}>
          <b style={{ fontWeight: 600 }}>{row.headline}</b>
        </div>
        {row.detail ? <div style={EV_DETAIL}>{row.detail}</div> : null}
      </div>
    </div>
  );
}
