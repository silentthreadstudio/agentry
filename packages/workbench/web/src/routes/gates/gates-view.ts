// Gates view-model + styles — the gate-inbox derivations + deep-link helpers + inline styles, kept out of
// Gates.tsx (then pure render). Pure (unit-testable, no React/JSX): one OpenGateItem → a renderable GateRow
// (headline + open-comment summary + the jump-to-doc-at-gate deep link). The link reuses works-view's
// `runHref` so a gate jump and a Works-card click land on the identical route.
import type { CSSProperties } from "react";
import type { OpenGateItem } from "../../api/index.js";
import { runHref } from "../board/board-view.js";

export interface GateRow {
  run: string;
  gate: string;
  docId: string;
  headline: string;
  detail: string;
  href: string; // the jump-to-doc-at-gate target (an in-app route path)
}

/** The in-app path that opens the doc at the gate: the run's work route with `?doc=<docId>`. Navigate,
 *  don't re-implement the drawer — the work shell reads the param to open the gate's document. Same
 *  origin as the inbox, so opening a gate is a route change rather than a page load. */
function gateHref(item: Pick<OpenGateItem, "run" | "docId">): string {
  return `${runHref(item.run)}?doc=${encodeURIComponent(item.docId)}`;
}

export function toGateRow(item: OpenGateItem): GateRow {
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
    href: gateHref(item),
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
