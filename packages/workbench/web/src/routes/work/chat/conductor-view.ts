// conductor-view — the inline styles for the conductor thread, kept out of the component (the same
// view-model/styles split every other route here uses: Activity/Gates/Works all keep their CSSProperties
// beside the component, not inside it).
//
// Deliberately quiet: this is a conversation inside a workspace, not a chat product. The two sides are
// distinguished by alignment and a single tinted border rather than by loud colored bubbles, so the
// thread stays legible next to the graph and the docs on the same dark surface.
import type { CSSProperties } from "react";

export const CONVO: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
};

export const STREAM: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: "22px 26px",
};

const BUBBLE_BASE: CSSProperties = {
  maxWidth: "min(680px, 78%)",
  borderRadius: 14,
  padding: "10px 13px",
  fontSize: 13.5,
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  border: "1px solid var(--line)",
};

/** The human's message: aligned trailing, on the raised surface — you speak from your side. */
export const BUBBLE: CSSProperties = {
  ...BUBBLE_BASE,
  alignSelf: "flex-end",
  background: "linear-gradient(180deg, #1b1b26, #14141b)",
};

/** The agent's `channel_reply`, aligned leading with a violet edge — the accent Agentry uses for agent
 *  action everywhere else in the UI. */
export const BUBBLE_AGENT: CSSProperties = {
  ...BUBBLE_BASE,
  alignSelf: "flex-start",
  background: "linear-gradient(180deg, #16161e, #101015)",
  borderColor: "#6d5bd033",
};

export const BUBBLE_META: CSSProperties = {
  font: "700 9px var(--sans)",
  letterSpacing: "0.8px",
  textTransform: "uppercase",
  color: "var(--faint)",
  marginBottom: 4,
};

export const COMPOSER: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 10,
  padding: "12px 26px 16px",
  borderTop: "1px solid var(--line)",
};

export const INPUT: CSSProperties = {
  flex: 1,
  resize: "none",
  borderRadius: 12,
  border: "1px solid var(--line)",
  background: "#0f0f14",
  color: "inherit",
  font: "inherit",
  fontSize: 13.5,
  padding: "10px 12px",
  minHeight: 44,
};

export const SEND: CSSProperties = {
  borderRadius: 10,
  border: "1px solid #6d5bd055",
  background: "linear-gradient(180deg, #2a2540, #1b1830)",
  color: "#e9e6ff",
  font: "600 12.5px var(--sans)",
  padding: "11px 16px",
  cursor: "pointer",
};
