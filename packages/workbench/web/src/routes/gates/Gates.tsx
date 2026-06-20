// Gates — the waiting-on-you inbox (the /gates sidebar page). Consumes GET /api/gates → OpenGateItem[] (task
// 20's gate-inbox: every gate with at least one UNRESOLVED review comment). Each row jumps to the doc at the
// gate — it NAVIGATES the browser to that run's work host with the doc encoded in the URL; it does NOT
// re-implement the DocDrawer (the drawer lives on the run host, behind selectDoc). Dark + calm (AC8); the
// empty state — "nothing waiting on you" — is a good state (VISION §3). Read-only inbox: it routes, it never
// resolves a gate. The view-model (OpenGateItem → GateRow), the deep-link helpers, and the inline styles
// live in `gates-view`.
import { useEffect, useState } from "react";
import { ApiError, fetchGates } from "../../api/index.js";
import type { OpenGateItem } from "../../api/index.js";
import { Button, EmptyState } from "../../ui/index.js";
import {
  GATE,
  GATE_DETAIL,
  GATE_ICON,
  GATE_TITLE,
  toGateRow,
  type GateRow,
} from "./gates-view.js";

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
