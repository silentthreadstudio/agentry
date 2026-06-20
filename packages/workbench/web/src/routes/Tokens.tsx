// Tokens — the usage chart (the /tokens sidebar page). Consumes GET /api/tokens?run=<id> → TokenSeries (task
// 21's token-reader: parallel ISO `timestamps[]` + cumulative `tokens[]`, per day). Renders a small inline
// SVG area+line chart in the self-eval dashboard's visual language (neutral-black canvas, violet=actions —
// recalled) plus a couple of KPI tiles. The transcript source is the least-pinned contract (plan §7.3): an
// EMPTY series renders a clean degraded state, never an error. Dark + calm (AC8); empty is a good state.
//
// Run scope: Tokens is per-run. On a run host (<id>.localhost) `runId` is that run; on the bare host there
// is no single run, so the series is empty and the page shows the calm "pick a run" degraded state — the
// contract-faithful behavior (the endpoint returns an empty series without ?run=).
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { TokenSeries } from "@agentry/workbench-shared";
import { ApiError, fetchTokens } from "../api/client.js";
import { EmptyState } from "../design-system/index.js";

// ── Chart geometry (pure, exported for unit test) ──────────────────────────────────────────────────────
// Map a TokenSeries to SVG point coords inside a [w × h] box with padding. X is evenly spaced across the
// samples (the series is already per-day, ordered); Y is the cumulative token count scaled to the max. A
// single sample sits mid-box; an empty series yields no points (the caller renders the degraded state).
export interface ChartGeometry {
  points: Array<{ x: number; y: number }>;
  linePath: string; // the polyline "M..L.." through the points
  areaPath: string; // the closed area under the line (filled)
  max: number; // the peak cumulative value (for the axis label)
}

export function chartGeometry(series: TokenSeries, w: number, h: number, pad = 8): ChartGeometry | null {
  const n = series.tokens.length;
  if (n === 0) return null;
  const max = series.tokens.reduce((m, t) => (t > m ? t : m), 0);
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  const xAt = (i: number) => (n === 1 ? w / 2 : pad + (innerW * i) / (n - 1));
  const yAt = (v: number) => pad + innerH - (max === 0 ? 0 : (innerH * v) / max);

  const points = series.tokens.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  const baseline = pad + innerH;
  const areaPath =
    first && last ? `${linePath} L${last.x.toFixed(1)} ${baseline} L${first.x.toFixed(1)} ${baseline} Z` : "";

  return { points, linePath, areaPath, max };
}

/** A compact token count: 1_460_000 → "1.46M", 42_000 → "42.0k", 980 → "980". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** A sample timestamp's short day label for the x-axis ticks ("Jun 19"). */
export function dayTick(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Component ────────────────────────────────────────────────────────────────────────────────────────
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; series: TokenSeries };

export function Tokens({ runId }: { runId?: string }) {
  const [state, setState] = useState<LoadState>(
    runId ? { kind: "loading" } : { kind: "ready", series: { timestamps: [], tokens: [] } },
  );

  useEffect(() => {
    if (!runId) {
      setState({ kind: "ready", series: { timestamps: [], tokens: [] } });
      return;
    }
    const ctrl = new AbortController();
    setState({ kind: "loading" });
    fetchTokens(runId, ctrl.signal)
      .then((series) => setState({ kind: "ready", series }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const message =
          err instanceof ApiError ? `Couldn’t load token usage (${err.status}).` : "Couldn’t load token usage.";
        setState({ kind: "error", message });
      });
    return () => ctrl.abort();
  }, [runId]);

  if (state.kind === "loading") return <div className="page"><EmptyState>Loading usage…</EmptyState></div>;
  if (state.kind === "error")
    return (
      <div className="page">
        <EmptyState title="Can’t reach the server">{state.message}</EmptyState>
      </div>
    );

  const { series } = state;
  const empty = series.tokens.length === 0;

  if (empty) {
    return (
      <div className="page">
        <EmptyState title="No usage yet">
          {runId
            ? "Token usage for this run will appear here once Agentry records its session transcripts."
            : "Token usage is per-run — open a run to see its usage chart."}
        </EmptyState>
        <div style={SOURCE}>
          Source · Claude Code session transcripts (the same data behind <span className="muted">/session-report</span>).
        </div>
      </div>
    );
  }

  return <TokenChart series={series} />;
}

const CHART_W = 920;
const CHART_H = 200;

function TokenChart({ series }: { series: TokenSeries }) {
  const geo = useMemo(() => chartGeometry(series, CHART_W, CHART_H), [series]);
  const total = series.tokens[series.tokens.length - 1] ?? 0;
  const days = series.timestamps.length;

  return (
    <div className="page">
      <div style={KPIS}>
        <Kpi label="Tokens · this run" value={formatTokens(total)} detail={`cumulative across ${days} day${days === 1 ? "" : "s"}`} />
        <Kpi label="Samples" value={String(days)} detail="per-day cumulative points" />
        <Kpi label="Peak day" value={formatTokens(geo?.max ?? 0)} detail="highest cumulative reading" />
      </div>

      <div style={CHART_BOX}>
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          width="100%"
          height={CHART_H}
          role="img"
          aria-label={`Cumulative token usage across ${days} days, peaking at ${formatTokens(geo?.max ?? 0)} tokens.`}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="tok-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {geo ? (
            <>
              <path d={geo.areaPath} fill="url(#tok-area)" stroke="none" />
              <path d={geo.linePath} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
              {geo.points.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="var(--accent)" />
              ))}
            </>
          ) : null}
        </svg>
        <div style={TICKS}>
          {series.timestamps.map((t, i) => (
            <span key={i} style={TICK}>
              {dayTick(t)}
            </span>
          ))}
        </div>
      </div>

      <div style={SOURCE}>
        Source · Claude Code session transcripts (the same data behind <span className="muted">/session-report</span>).
      </div>
    </div>
  );
}

function Kpi({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div style={KPI}>
      <div style={KPI_L}>{label}</div>
      <div style={KPI_V}>{value}</div>
      <div style={KPI_D}>{detail}</div>
    </div>
  );
}

// Inline styles on the design tokens (the prototype's .kpis / .bars surfaces, here an SVG area chart in the
// self-eval visual language — neutral-black canvas + the violet --accent. Styled inline because the page CSS
// classes live in task 10's stylesheet, not this owned route file).
const KPIS: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 22 };
const KPI: CSSProperties = { border: "1px solid var(--line)", borderRadius: 12, background: "var(--panel)", padding: 15 };
const KPI_L: CSSProperties = { fontSize: 11.5, color: "var(--faint)" };
const KPI_V: CSSProperties = { fontSize: 24, fontWeight: 680, letterSpacing: "-.5px", marginTop: 5 };
const KPI_D: CSSProperties = { fontSize: 11.5, color: "var(--muted)", marginTop: 3 };
const CHART_BOX: CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 12,
  background: "var(--panel)",
  padding: 14,
};
const TICKS: CSSProperties = { display: "flex", justifyContent: "space-between", marginTop: 8 };
const TICK: CSSProperties = { fontSize: 10.5, color: "var(--faint)" };
const SOURCE: CSSProperties = { fontSize: 11.5, color: "var(--faint)", marginTop: 10 };
