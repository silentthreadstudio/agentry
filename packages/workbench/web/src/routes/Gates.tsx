// Gates — the waiting-on-you inbox (the /gates sidebar page). Consumes GET /api/gates → OpenGateItem[] (task
// 20's gate-inbox: every gate with at least one UNRESOLVED review comment). Each row jumps to the doc at the
// gate — it NAVIGATES the browser to that run's work host with the doc encoded in the URL; it does NOT
// re-implement the DocDrawer (the drawer lives on the run host, behind selectDoc). Dark + calm (AC8); the
// empty state — "nothing waiting on you" — is a good state (VISION §3). Read-only inbox: it routes, it never
// resolves a gate (resolving happens at the FLOW gate, in the doc).
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { ApiError, fetchGates } from "../api/index.js";
import type { OpenGateItem } from "../api/index.js";
import { Button, EmptyState } from "../design-system/index.js";

// ── View model ─────────────────────────────────────────────────────────────────────────────────────────
// Pure, exported for unit test. A gate row's headline ("<gate> gate · <run>") + a detail summarizing its
// open comments (the count, and the first comment's body as a preview) — what the human decides on.
export interface GateRow {
  run: string;
  gate: string;
  docId: string;
  headline: string;
  detail: string;
  href: string; // the jump-to-doc-at-gate target (cross-host deep link)
}

/** The host a run's work shell is reached on — same scheme/host/port, only the subdomain becomes <run>.
 *  Mirrors Works.tsx's runHref so a gate jump and a Works-card click land on the identical host. */
export function runHost(runId: string, loc: Pick<Location, "protocol" | "hostname" | "port"> = location): string {
  const baseHost = loc.hostname.replace(/^[^.]+\.(?=localhost$)/, "");
  const host = `${runId}.${baseHost}${loc.port ? `:${loc.port}` : ""}`;
  return `${loc.protocol}//${host}/`;
}

/** The deep link that opens the doc at the gate: the run's work host with `?doc=<docId>`. The work shell
 *  reads the param to open the drawer (the gate's document). Navigate, don't re-implement the drawer. */
export function gateHref(item: Pick<OpenGateItem, "run" | "docId">, loc?: Pick<Location, "protocol" | "hostname" | "port">): string {
  const base = runHost(item.run, loc ?? location);
  return `${base}?doc=${encodeURIComponent(item.docId)}`;
}

export function toGateRow(item: OpenGateItem, loc?: Pick<Location, "protocol" | "hostname" | "port">): GateRow {
  const open = item.comments.length;
  const first = item.comments[0]?.body?.trim();
  const detail =
    open === 0
      ? "waiting on you"
      : `${open} comment${open === 1 ? "" : "s"} awaiting${first ? ` — “${first}”` : ""}`;
  return {
    run: item.run,
    gate: item.gate,
    docId: item.docId,
    headline: `${item.gate} gate · ${item.run}`,
    detail,
    href: gateHref(item, loc),
  };
}

// ── Component ────────────────────────────────────────────────────────────────────────────────────────
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; gates: OpenGateItem[] };

export function Gates() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    fetchGates(undefined, ctrl.signal)
      .then((gates) => setState({ kind: "ready", gates }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const message =
          err instanceof ApiError ? `Couldn’t load the gate inbox (${err.status}).` : "Couldn’t load the gate inbox.";
        setState({ kind: "error", message });
      });
    return () => ctrl.abort();
  }, []);

  return (
    <div className="page">
      {state.kind === "loading" ? (
        <EmptyState>Loading the inbox…</EmptyState>
      ) : state.kind === "error" ? (
        <EmptyState title="Can’t reach the server">{state.message}</EmptyState>
      ) : state.gates.length === 0 ? (
        <EmptyState title="All clear">Nothing waiting on you.</EmptyState>
      ) : (
        state.gates.map((item) => <GateInboxRow key={`${item.run}/${item.gate}`} row={toGateRow(item)} />)
      )}
    </div>
  );
}

function GateInboxRow({ row }: { row: GateRow }) {
  const open = () => {
    location.href = row.href;
  };
  return (
    <div style={GATE}>
      <span style={GATE_ICON} aria-hidden="true">
        ◆
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={GATE_TITLE}>{row.headline}</div>
        <div style={GATE_DETAIL}>{row.detail}</div>
      </div>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
        <Button variant="secondary" onClick={open} aria-label={`Open the ${row.gate} gate in ${row.run}`}>
          Open
        </Button>
      </div>
    </div>
  );
}

// Inline styles on the design tokens (the prototype's .gate row — restyled here because the page CSS lives
// in task 10's stylesheet, not this owned route file).
const GATE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 13,
  border: "1px solid var(--line)",
  borderRadius: 11,
  background: "var(--panel)",
  padding: "13px 15px",
  marginBottom: 10,
};
const GATE_ICON: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  display: "grid",
  placeItems: "center",
  background: "var(--panel2)",
  border: "1px solid var(--line2)",
  fontSize: 13,
  flex: "none",
};
const GATE_TITLE: CSSProperties = { fontWeight: 600, fontSize: 13.5 };
const GATE_DETAIL: CSSProperties = {
  fontSize: 12,
  color: "var(--muted)",
  marginTop: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
