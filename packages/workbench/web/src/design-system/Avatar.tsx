// Avatar — the prototype's tiny round agent initial-badge (.av): a neutral grey disc with the
// agent's initials in dark ink. Derives initials from a hyphenated role/id ("product-owner" → "PO").
// Decorative when shown beside the agent's name; carries an aria-label when it stands alone.
import type { CSSProperties } from "react";

function initials(name: string): string {
  return name
    ? name
        .split("-")
        .map((w) => w[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "";
}

export interface AvatarProps {
  /** The agent id / role, e.g. "implementer" or "product-owner". */
  name: string;
  /** Diameter in px (prototype uses 18 inline, 26 in cards). */
  size?: number;
  /** True when the name is shown adjacent (avatar is then decorative). Default true. */
  decorative?: boolean;
  className?: string;
}

export function Avatar({ name, size = 18, decorative = true, className }: AvatarProps) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    fontSize: Math.max(8, Math.round(size * 0.42)),
    fontWeight: 700,
    color: "#0d0d11",
    background: "#9a9aa6",
    flex: "none",
  };
  return (
    <span
      className={className}
      style={style}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : name}
      role={decorative ? undefined : "img"}
    >
      {initials(name)}
    </span>
  );
}
