// Button — the prototype's .btn / .btn.primary. Secondary = a --panel2 chip with a --line2 border;
// primary = the inverted ink button (light fill, dark text — the one high-contrast call to action).
// A real <button> with hover/active/disabled states and the global focus-visible ring (a11y).
import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./Button.css";

export type ButtonVariant = "secondary" | "primary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

export function Button({ variant = "secondary", children, className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`ds-btn ds-btn--${variant} ${className ?? ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}
