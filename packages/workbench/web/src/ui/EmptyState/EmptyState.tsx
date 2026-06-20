// EmptyState — empty states are good states (VISION §3). The prototype's calm .empty: faint,
// centered, generous padding. Used for "nothing waiting on you", and as the "coming in this view"
// placeholder for Phase 2/3/4 routes this task only scaffolds. An optional title + body + slot.
import type { ReactNode } from "react";

export interface EmptyStateProps {
  /** The headline (e.g. "Panorama"). Optional — a one-line message can stand alone. */
  title?: string;
  /** The calm explanatory line. */
  children: ReactNode;
  /** Optional action / extra content below the message. */
  action?: ReactNode;
}

export function EmptyState({ title, children, action }: EmptyStateProps) {
  return (
    <div
      style={{
        color: "var(--faint)",
        textAlign: "center",
        padding: "56px 40px",
        fontSize: 13,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        maxWidth: 460,
        margin: "0 auto",
      }}
    >
      {title ? (
        <div style={{ color: "var(--muted)", fontSize: 14, fontWeight: 600 }}>{title}</div>
      ) : null}
      <div style={{ lineHeight: 1.55 }}>{children}</div>
      {action ? <div style={{ marginTop: 6 }}>{action}</div> : null}
    </div>
  );
}
