// Activity — this work's event timeline (the WorkLayout Activity tab). Consumes GET /api/events?run=<id>
// → EventView[] (task 20's one fold, filtered to this run) and renders it as the prototype's calm vertical
// timeline: a day-grouped list of routing-decision → gate → node-enter/node-done events, each with a
// monochrome glyph, a one-line headline, a muted detail, and (for node-done) the duration. Dark + calm
// (AC8); empty / loading / error are all good states (VISION §3). Read-only — a projection, never a write.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { EventView } from "@agentry/workbench-shared";
import { ApiError, fetchEvents } from "../../api/index.js";
import { EmptyState } from "../../design-system/index.js";

// ── View model: one EventView → a renderable timeline row ───────────────────────────────────────────────
// Pure, exported for unit test. Maps FLOW's closed event union to a glyph + headline + detail. The glyphs
// are text (no icon set — "no icon noise"); the headline names the event, the detail carries the specifics.
export interface TimelineRow {
  id: string;
  ts: string; // raw ISO (kept for grouping); `clock` is the rendered HH:MM
  clock: string;
  glyph: string;
  headline: string; // the bold lead (e.g. "routing-decision")
  detail: string; // the muted second line
}

const GLYPH = {
  "routing-decision": "◆",
  gate: "✓",
  "node-enter": "→",
  "node-done": "✓",
} as const;

/** HH:MM in local time, or "" when the timestamp is unparseable (a corrupt event never breaks the row). */
export function clockOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A node-done's durationMs as a compact human string ("420ms", "3.4s", "2m 05s"). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function toRow(view: EventView): TimelineRow {
  const e = view.event;
  const base = { id: view.id, ts: e.ts, clock: clockOf(e.ts) };
  switch (e.type) {
    case "routing-decision":
      return { ...base, glyph: GLYPH["routing-decision"], headline: "routing-decision", detail: `${e.shape} · ${e.kind}` };
    case "gate":
      return { ...base, glyph: GLYPH.gate, headline: `gate · ${e.gate}`, detail: e.outcome };
    case "node-enter":
      return { ...base, glyph: GLYPH["node-enter"], headline: `node-enter · ${e.node}`, detail: e.agent ? `dispatched ${e.agent}` : "" };
    case "node-done": {
      const d = formatDuration(e.durationMs);
      return { ...base, glyph: GLYPH["node-done"], headline: `node-done · ${e.node}`, detail: d ? `spent ${d}` : "" };
    }
  }
}

/** A coarse day label for a row's timestamp: Today / Yesterday / a date — the prototype's .daylbl groups. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Group rows into ordered day buckets (most recent events first within the run's file order). */
export function groupByDay(rows: TimelineRow[], now: Date = new Date()): Array<{ day: string; rows: TimelineRow[] }> {
  const groups: Array<{ day: string; rows: TimelineRow[] }> = [];
  for (const row of rows) {
    const day = dayLabel(row.ts, now);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  return groups;
}

// ── Component ────────────────────────────────────────────────────────────────────────────────────────
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

// Inline styles using the design tokens (the repo's primitives style this way — see StatusDot/EmptyState —
// since the prototype's page CSS classes are owned by task 10's stylesheet, not this route file).
const DAYLBL: CSSProperties = {
  fontSize: 11,
  letterSpacing: ".4px",
  textTransform: "uppercase",
  color: "var(--faint)",
  fontWeight: 600,
  margin: "18px 0 8px",
};
const EV: CSSProperties = { display: "flex", gap: 13, padding: "9px 4px", borderRadius: 8 };
const EV_TIME: CSSProperties = {
  font: "500 11.5px var(--mono)",
  color: "var(--faint)",
  width: 54,
  flex: "none",
  paddingTop: 1,
};
const EV_ICON: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 7,
  flex: "none",
  display: "grid",
  placeItems: "center",
  fontSize: 11,
  background: "var(--panel2)",
  border: "1px solid var(--line)",
};
const EV_DETAIL: CSSProperties = { fontSize: 12, color: "var(--muted)", marginTop: 1 };
