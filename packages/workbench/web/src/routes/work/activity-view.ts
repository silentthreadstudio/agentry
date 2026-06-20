// Activity view-model + styles — everything the Activity tab derives or styles, kept out of the component
// (Activity.tsx is then pure render). Pure functions (unit-testable, no React/JSX): one EventView → a
// renderable TimelineRow (FLOW's closed event union → glyph + headline + detail), the clock/duration/day
// formatters, and the day-grouping. The inline token-styles live here too (the route uses inline styles —
// the page CSS classes are owned by App.css, not this route).
import type { CSSProperties } from "react";
import type { EventView } from "@agentry/workbench-shared";

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

/** A coarse day label for a row's timestamp: Today / Yesterday / a date — the .daylbl groups. */
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

// ── Inline token-styles (the route styles this way — the page CSS classes are owned by App.css) ──────
export const DAYLBL: CSSProperties = {
  fontSize: 11,
  letterSpacing: ".4px",
  textTransform: "uppercase",
  color: "var(--faint)",
  fontWeight: 600,
  margin: "18px 0 8px",
};
export const EV: CSSProperties = { display: "flex", gap: 13, padding: "9px 4px", borderRadius: 8 };
export const EV_TIME: CSSProperties = {
  font: "500 11.5px var(--mono)",
  color: "var(--faint)",
  width: 54,
  flex: "none",
  paddingTop: 1,
};
export const EV_ICON: CSSProperties = {
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
export const EV_DETAIL: CSSProperties = { fontSize: 12, color: "var(--muted)", marginTop: 1 };
