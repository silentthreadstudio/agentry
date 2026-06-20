// Memory — the moat browser (the /memory sidebar page, design/memory.html approved as-is). Consumes
// GET /api/memory → MemReadRecord[] (task 21's mem-reader: facts + episodes across BOTH roots — project
// .agentry/memory + global ~/.agentry/memory). Search drives ?q=<text> (server-side filter, debounced);
// the kind segment (All/Facts/Episodes), the type chips, and the project/global segment filter the fetched
// list CLIENT-SIDE. Six metric tiles are counts derived from the fetched list. The detail panel renders the
// selected record's body as markdown (markdown-it, the renderer the doc serializer already bundles) plus
// the frontmatter-derived meta pills, a "Why" callout, and a Provenance list. V1 NON-GOAL: editing memory —
// no write affordance. The page title lives in App.tsx's PageHero; this is the body BELOW it.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import MarkdownIt from "markdown-it";
import { ApiError, fetchMemory } from "../api/index.js";
import type { MemReadRecord } from "../api/index.js";
import { EmptyState, SearchInput } from "../design-system/index.js";
import { applyFilters, metricsFor, toMemRow, typeColor } from "./memory-view.js";
import type { KindFilter, MemRow, OriginFilter } from "./memory-view.js";
import "./memory.css";

/** The badge's tinted background — the type hue at low alpha over the panel (the mockup's #2a1714 etc). */
function typeBadge(type: string): CSSProperties {
  const c = typeColor(type);
  return { color: c, background: `color-mix(in srgb, ${c} 16%, var(--panel))` };
}

// ── Markdown (read-only render of local file content; markdown-it the doc layer already bundles) ─────────
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// ── Component ────────────────────────────────────────────────────────────────────────────────────────
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; records: MemReadRecord[] };

export function Memory() {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [originFilter, setOriginFilter] = useState<OriginFilter>("all");
  const [selected, setSelected] = useState<string | undefined>(undefined);

  // Debounced server-side search: every settled query fetches /api/memory?q=… (browse when empty). The mem
  // store is small and local, so a short debounce keeps keystrokes from stampeding the reader.
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetchMemory(query, ctrl.signal)
        .then((records) => setState({ kind: "ready", records }))
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          const message =
            err instanceof ApiError ? `Couldn’t load memory (${err.status}).` : "Couldn’t load memory.";
          setState({ kind: "error", message });
        });
    }, query ? 180 : 0);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  const records = state.kind === "ready" ? state.records : [];
  const allRows = useMemo(() => records.map(toMemRow), [records]);
  const rows = useMemo(
    () => applyFilters(allRows, kindFilter, typeFilter, originFilter),
    [allRows, kindFilter, typeFilter, originFilter],
  );
  const metrics = useMemo(() => metricsFor(records), [records]);
  // The distinct types present, for the chip row (data-driven so a never-seen type doesn't show a dead chip).
  const types = useMemo(() => {
    const seen = new Set(allRows.map((r) => r.type));
    return [...seen].sort();
  }, [allRows]);
  const counts = useMemo(() => {
    const project = allRows.filter((r) => r.origin === "project").length;
    return { project, global: allRows.length - project };
  }, [allRows]);

  // The selected row, defaulting to the first in the filtered view (so the panel is never blank when the
  // list has content). A selection that filters out falls back to the first visible row.
  const selectedRow =
    rows.find((r) => r.id === selected) ?? rows[0];

  if (state.kind === "loading") {
    return (
      <div className="mem">
        <EmptyState>Loading memory…</EmptyState>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mem">
        <EmptyState title="Can’t reach the server">{state.message}</EmptyState>
      </div>
    );
  }

  return (
    <div className="mem">
      <div className="mem-metrics">
        {metrics.map((m) => (
          <div className="mem-kpi" key={m.k}>
            <div className="k">
              <span className="mem-sw" style={{ background: m.color }} />
              {m.k}
            </div>
            <div className="v">{m.v}</div>
          </div>
        ))}
      </div>

      <div className="mem-filters">
        <div className="mem-search">
          <SearchInput value={query} onChange={setQuery} placeholder="Search memory…" label="Search memory" />
        </div>

        <div className="mem-seg" role="group" aria-label="Filter by kind">
          {(["all", "facts", "episodes"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={k === kindFilter ? "on" : ""}
              aria-pressed={k === kindFilter}
              onClick={() => setKindFilter(k)}
            >
              {k === "all" ? "All" : k === "facts" ? "Facts" : "Episodes"}
            </button>
          ))}
        </div>

        <div className="mem-chips" role="group" aria-label="Filter by type">
          <button
            type="button"
            className={`mem-fchip${typeFilter === "all" ? " on" : ""}`}
            aria-pressed={typeFilter === "all"}
            onClick={() => setTypeFilter("all")}
          >
            all types
          </button>
          {types.map((t) => (
            <button
              key={t}
              type="button"
              className={`mem-fchip${typeFilter === t ? " on" : ""}`}
              aria-pressed={typeFilter === t}
              onClick={() => setTypeFilter(t)}
            >
              <span className="mem-sw" style={{ background: typeColor(t) }} />
              {t}
            </button>
          ))}
        </div>

        <div className="mem-seg" role="group" aria-label="Filter by store">
          {(["project", "global"] as const).map((o) => (
            <button
              key={o}
              type="button"
              className={o === originFilter ? "on" : ""}
              aria-pressed={o === originFilter}
              onClick={() => setOriginFilter((cur) => (cur === o ? "all" : o))}
            >
              {o === "project" ? "Project" : "Global"} {counts[o]}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={query ? "No matches" : "No memory yet"}>
          {query
            ? `Nothing in memory matches “${query.trim()}”.`
            : "As Agentry learns, its curated facts and episodes appear here — read-only."}
        </EmptyState>
      ) : (
        <div className="mem-split">
          <div className="mem-list" role="list">
            {rows.map((r) => (
              <button
                key={`${r.origin}/${r.kind}/${r.id}`}
                type="button"
                role="listitem"
                className={`mem-card${selectedRow?.id === r.id ? " on" : ""}`}
                aria-pressed={selectedRow?.id === r.id}
                onClick={() => setSelected(r.id)}
              >
                <div className="mem-mrow">
                  <span className="mem-tbadge" style={typeBadge(r.type)}>
                    {r.type}
                  </span>
                  <span className="mem-org">
                    <span className="mem-sw" style={{ background: r.origin === "global" ? typeColor("episode") : typeColor("repo-fact") }} />
                    {r.origin}
                  </span>
                </div>
                <div className="mem-mtitle">{r.title}</div>
                {r.tags.length > 0 ? (
                  <div className="mem-mtags">
                    {r.tags.slice(0, 4).map((t) => (
                      <span className="mem-tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
              </button>
            ))}
          </div>

          {selectedRow ? <MemDetail row={selectedRow} /> : <div className="mem-detail mem-detail-empty">Select a record</div>}
        </div>
      )}
    </div>
  );
}

function MemDetail({ row }: { row: MemRow }) {
  const html = useMemo(() => md.render(row.body), [row.body]);
  return (
    <div className="mem-detail">
      <div className="mem-dhead">
        <span className="mem-tbadge" style={typeBadge(row.type)}>
          {row.type}
        </span>
        <span className="mem-org" style={{ marginLeft: 0 }}>
          <span className="mem-sw" style={{ background: row.origin === "global" ? typeColor("episode") : typeColor("repo-fact") }} />
          {row.origin} · {row.kind === "episodes" ? "episode" : "fact"}
        </span>
      </div>
      <div className="mem-dtitle">{row.title}</div>

      <div className="mem-meta">
        {row.confidence !== undefined ? (
          <span className="mem-mpill">
            confidence
            <span className="mem-bar">
              <i style={{ width: `${Math.round(Math.max(0, Math.min(1, row.confidence)) * 100)}%` }} />
            </span>
          </span>
        ) : null}
        {row.usefulness !== undefined ? (
          <span className="mem-mpill">
            usefulness <b>★ {row.usefulness}</b>
          </span>
        ) : null}
        <span className="mem-mpill">
          id <b>{row.id}</b>
        </span>
        {row.createdAt ? (
          <span className="mem-mpill">
            created <b>{row.createdAt}</b>
          </span>
        ) : null}
      </div>

      <div className="mem-body">
        {/* eslint-disable-next-line react/no-danger -- local, read-only mem file content; markdown-it html:false */}
        <div className="mem-md" dangerouslySetInnerHTML={{ __html: html }} />

        {row.why ? (
          <div className="mem-why">
            <b>Why it matters</b>
            {row.why}
          </div>
        ) : null}

        {row.provenance.length > 0 ? (
          <div className="mem-prov">
            <div className="k">Provenance</div>
            {row.provenance.map((p) => (
              <span className="p" key={p}>
                {p}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
