// Gates view-model + styles — the gate-inbox derivations + deep-link helpers + inline styles, kept out of
// Gates.tsx (then pure render). Pure (unit-testable, no React/JSX): one OpenGateItem → a renderable GateRow
// (headline + open-comment summary + the jump-to-doc-at-gate deep link). `runHost` mirrors works-view's
// runHref so a gate jump and a Works-card click land on the identical host.
import type { CSSProperties } from "react";
import type { OpenGateItem } from "../api/index.js";

export interface GateRow {
  run: string;
  gate: string;
  docId: string;
  headline: string;
  detail: string;
  href: string; // the jump-to-doc-at-gate target (cross-host deep link)
}

/** The host a run's work shell is reached on — same scheme/host/port, only the subdomain becomes <run>. */
export function runHost(runId: string, loc: Pick<Location, "protocol" | "hostname" | "port"> = location): string {
  const baseHost = loc.hostname.replace(/^[^.]+\.(?=localhost$)/, "");
  const host = `${runId}.${baseHost}${loc.port ? `:${loc.port}` : ""}`;
  return `${loc.protocol}//${host}/`;
}

/** The deep link that opens the doc at the gate: the run's work host with `?doc=<docId>`. Navigate, don't
 *  re-implement the drawer — the work shell reads the param to open the gate's document. */
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

// ── Inline token-styles (the page CSS classes are owned by App.css; this route styles inline) ────────
export const GATE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 13,
  border: "1px solid var(--line)",
  borderRadius: 11,
  background: "var(--panel)",
  padding: "13px 15px",
  marginBottom: 10,
};
export const GATE_ICON: CSSProperties = {
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
export const GATE_TITLE: CSSProperties = { fontWeight: 600, fontSize: 13.5 };
export const GATE_DETAIL: CSSProperties = {
  fontSize: 12,
  color: "var(--muted)",
  marginTop: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
