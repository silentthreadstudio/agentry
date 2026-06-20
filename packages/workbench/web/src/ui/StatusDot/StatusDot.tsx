// StatusDot — the prototype's signature status affordance: a small colored dot + a muted text
// label (status is NEVER conveyed by color alone — a11y, VISION's near-monochrome language).
// Maps FLOW's closed FlowTaskStatus union (todo · in-progress · in-review · done) plus the derived
// "blocked" state the graph surfaces. A closed map → a new status is a compile error, not a grey dot.
import type { CSSProperties } from "react";
import type { RunSummary } from "@agentry/workbench-shared";

// FLOW's closed task-status union. Derived from the read-model's taskCounts keys rather than imported
// from @agentry/flow directly, so the web layer depends only on the read-model contract (and a FLOW
// status change still ripples here as a compile error via RunSummary). "blocked" is not a task status
// (it is an AgentState / derived graph state) but the prototype renders it in the same dot vocabulary,
// so this primitive accepts the superset.
export type FlowTaskStatus = keyof RunSummary["taskCounts"];
export type DotStatus = FlowTaskStatus | "blocked";

const HUE: Record<DotStatus, string> = {
  done: "var(--done)",
  "in-progress": "var(--prog)",
  "in-review": "var(--rev)",
  blocked: "var(--block)",
  todo: "var(--todo)",
};

const LABEL: Record<DotStatus, string> = {
  done: "Done",
  "in-progress": "In progress",
  "in-review": "In review",
  blocked: "Blocked",
  todo: "To do",
};

// in-progress (and blocked) get the soft halo the prototype uses to draw the eye to live work.
const HALO = new Set<DotStatus>(["in-progress"]);

export interface StatusDotProps {
  status: DotStatus;
  /** Render the text label beside the dot (default true). Set false for a bare dot in dense rows. */
  showLabel?: boolean;
  className?: string;
}

export function StatusDot({ status, showLabel = true, className }: StatusDotProps) {
  const dotStyle: CSSProperties = {
    width: 7,
    height: 7,
    borderRadius: "50%",
    display: "inline-block",
    flex: "none",
    background: HUE[status],
    ...(HALO.has(status)
      ? { boxShadow: `0 0 0 3px color-mix(in srgb, ${HUE[status]} 16%, transparent)` }
      : {}),
  };

  if (!showLabel) {
    // a11y: a bare dot needs an accessible name since color/shape alone is not enough.
    return <span role="img" aria-label={LABEL[status]} className={className} style={dotStyle} />;
  }

  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        color: "var(--muted)",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true" style={dotStyle} />
      {LABEL[status]}
    </span>
  );
}
