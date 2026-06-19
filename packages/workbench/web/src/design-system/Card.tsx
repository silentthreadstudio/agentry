// Card — the prototype's surface primitive: a --panel fill, a hairline --line border, 12px radius,
// 14px padding. Used for the Works run cards, the agent cards, the KPI tiles. When `interactive`,
// it renders as a real <button> (keyboard-operable, focus-ring, hover lift) so a clickable card is
// not a div-with-onClick (a11y: clickable surfaces must be reachable and activatable by keyboard).
import type { CSSProperties, ReactNode } from "react";

export interface CardProps {
  children: ReactNode;
  /** Makes the card a focusable, clickable button with the prototype's hover-lift. */
  interactive?: boolean;
  onClick?: () => void;
  /** Accessible name for an interactive card (required when interactive — its content may be visual). */
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

const BASE: CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--r-xl)",
  background: "var(--panel)",
  padding: "var(--sp-4)",
  textAlign: "left",
  color: "var(--ink)",
  display: "block",
  width: "100%",
};

export function Card({ children, interactive, onClick, ariaLabel, className, style }: CardProps) {
  if (interactive) {
    return (
      <button
        type="button"
        className={`ds-card ds-card--interactive ${className ?? ""}`}
        aria-label={ariaLabel}
        onClick={onClick}
        style={{ ...BASE, cursor: "pointer", font: "inherit", ...style }}
      >
        {children}
      </button>
    );
  }
  return (
    <div className={`ds-card ${className ?? ""}`} style={{ ...BASE, ...style }}>
      {children}
    </div>
  );
}
