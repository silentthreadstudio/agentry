// SearchInput — the prototype's .search field: a --panel fill, --line2 border, 10px radius, faint
// placeholder. A controlled text input with a visually-hidden label (a11y: every field needs a
// programmatic name even when the placeholder carries the visible hint).
import type { ChangeEvent } from "react";

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible label (visually hidden) — defaults to the placeholder text. */
  label?: string;
  className?: string;
}

export function SearchInput({ value, onChange, placeholder, label, className }: SearchInputProps) {
  const name = label ?? placeholder ?? "Search";
  return (
    <label className={className} style={{ display: "block" }}>
      <span
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {name}
      </span>
      <input
        type="search"
        className="ds-search"
        value={value}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      />
    </label>
  );
}
