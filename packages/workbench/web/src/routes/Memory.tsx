// Memory — read-only browse/search of the mem store (the /memory sidebar page). Consumes GET /api/memory →
// MemReadRecord[] (task 21's mem-reader: facts + episodes across BOTH roots — project .agentry/memory +
// global ~/.agentry/memory). SearchInput drives ?q=<text> (server-side filter). Each record shows its kind
// (fact / episode), its origin (project / global), its body prose, and a provenance line. V1 NON-GOAL:
// editing memory — this page has NO write affordance (no edit, no delete, no add). Dark + calm (AC8); empty
// is a good state (VISION §3).
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { ApiError, fetchMemory } from "../api/client.js";
import type { MemReadRecord } from "../api/client.js";
import { EmptyState, SearchInput } from "../design-system/index.js";

// ── View model (pure, exported for unit test) ──────────────────────────────────────────────────────────
// A record's display shape: the singular kind label, the origin label, the body prose (the store keeps a
// fact's text under `fields.text`, an episode's under `fields.task`), and a short provenance line from the
// frontmatter fields a human scans for (the id, plus any `provenance`/`source`/`run`/`task` hint present).
export interface MemRow {
  id: string;
  kind: "fact" | "episode";
  origin: "global" | "project";
  body: string;
  provenance: string;
}

const KIND_LABEL: Record<MemReadRecord["kind"], "fact" | "episode"> = { facts: "fact", episodes: "episode" };
const BODY_FIELD: Record<MemReadRecord["kind"], string> = { facts: "text", episodes: "task" };

/** A frontmatter value rendered as a short string, or "" when it isn't a scalar we can show inline. */
function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function toMemRow(record: MemReadRecord): MemRow {
  const body = scalar(record.fields[BODY_FIELD[record.kind]]).trim();
  const hint = ["provenance", "source", "run", "task", "commit"]
    .map((k) => scalar(record.fields[k]).trim())
    .find((v) => v.length > 0);
  return {
    id: record.id,
    kind: KIND_LABEL[record.kind],
    origin: record.origin,
    body: body || "(no body)",
    provenance: hint ? `${record.id} · ${hint}` : record.id,
  };
}

// The mem-store's kind tones, echoing the prototype's tag palette (a fact = the green repo-fact tone, an
// episode = the violet learning tone). Color is a *secondary* cue — the text label carries the meaning.
const KIND_TONE: Record<MemRow["kind"], CSSProperties> = {
  fact: { color: "#5db58a", background: "#122119" },
  episode: { color: "#b98fe0", background: "#201730" },
};
const ORIGIN_TONE: CSSProperties = { color: "var(--muted)", border: "1px solid var(--line2)" };

// ── Component ────────────────────────────────────────────────────────────────────────────────────────
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; records: MemReadRecord[] };

export function Memory() {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<LoadState>({ kind: "loading" });

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

  const ready = state.kind === "ready";

  return (
    <div className="page">
      <div style={{ marginBottom: 16 }}>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search facts & episodes…"
          label="Search memory"
        />
      </div>

      {state.kind === "loading" ? (
        <EmptyState>Loading memory…</EmptyState>
      ) : state.kind === "error" ? (
        <EmptyState title="Can’t reach the server">{state.message}</EmptyState>
      ) : state.records.length === 0 ? (
        <EmptyState title={query ? "No matches" : "No memory yet"}>
          {query
            ? `Nothing in memory matches “${query.trim()}”.`
            : "As Agentry learns, its curated facts and episodes appear here — read-only."}
        </EmptyState>
      ) : (
        <>
          {state.records.map((r) => (
            <MemCard key={`${r.origin}/${r.kind}/${r.id}`} row={toMemRow(r)} />
          ))}
        </>
      )}

      {ready ? (
        <div style={FOOT}>
          Read-only — memory is agent-curated (reflect / distill). The Workbench shows it; it never edits it.
        </div>
      ) : null}
    </div>
  );
}

function MemCard({ row }: { row: MemRow }) {
  return (
    <div style={CARD}>
      <div style={TAGS}>
        <span style={{ ...TAG, ...KIND_TONE[row.kind] }}>{row.kind}</span>
        <span style={{ ...TAG, ...ORIGIN_TONE }}>{row.origin}</span>
      </div>
      <div style={BODY}>{row.body}</div>
      <div style={PROV}>{row.provenance}</div>
    </div>
  );
}

// Inline styles on the design tokens (the prototype's .mfact / .tagk surfaces — styled inline because the
// page CSS classes live in task 10's stylesheet, not this owned route file).
const CARD: CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 11,
  background: "var(--panel)",
  padding: "13px 14px",
  marginBottom: 10,
};
const TAGS: CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginBottom: 5 };
const TAG: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: ".4px",
  textTransform: "uppercase",
  padding: "2px 7px",
  borderRadius: 6,
};
const BODY: CSSProperties = { fontSize: 13, color: "#c9c9d4", lineHeight: 1.55 };
const PROV: CSSProperties = { font: "500 11px var(--mono)", color: "var(--faint)", marginTop: 7, wordBreak: "break-all" };
const FOOT: CSSProperties = { fontSize: 11.5, color: "var(--faint)", marginTop: 6 };
