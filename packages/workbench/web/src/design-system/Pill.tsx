// Pill — the bordered chip the prototype uses in the header (the routing-shape pill, the host
// label). Two tones: the default muted chip and the "route" accent variant (the soft-violet chip
// that names the run's routing shape). Whitespace + a hairline border, no fill on the default.
import type { CSSProperties, ReactNode } from "react";

export type PillTone = "default" | "route";

export interface PillProps {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
}

const TONE: Record<PillTone, CSSProperties> = {
  default: {
    border: "1px solid var(--line2)",
    color: "var(--muted)",
  },
  route: {
    border: "1px solid var(--accent-line)",
    color: "var(--accent-ink)",
    background: "var(--accent-soft)",
  },
};

export function Pill({ tone = "default", children, className }: PillProps) {
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: "var(--r-md)",
        padding: "5px 10px",
        fontSize: 12,
        whiteSpace: "nowrap",
        ...TONE[tone],
      }}
    >
      {children}
    </span>
  );
}
