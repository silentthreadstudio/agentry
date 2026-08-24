// SourceMode — the CodeMirror raw-markdown escape hatch (ADR-004, the safety valve). It edits the
// artifact `body` as PLAIN TEXT, bypassing the Tiptap serializer entirely: the power-edit path and the
// fallback for any construct the rich schema doesn't model. The byte-stability guarantee lives at the
// SAVE seam (DocDrawer): source-mode text is `normalize`d on save exactly like the rich path, so a
// no-op edit re-serializes to the same bytes → same version → no false optimistic-concurrency rejection
// (ADR-006). This component is a thin controlled wrapper; it owns no save/lock logic.
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";

// The dark theme matching the prototype's editor surface (tokens.css palette). Defined once so the raw
// view reads as the same calm dark canvas as the rich editor, not a default light CodeMirror.
const theme = EditorView.theme(
  {
    "&": { color: "#d6d6e2", backgroundColor: "transparent", fontSize: "13px" },
    ".cm-content": {
      fontFamily: "var(--mono)",
      caretColor: "var(--ink)",
      padding: "8px 0",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--faint)",
      border: "none",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,.02)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "rgba(110,114,232,.25)",
    },
    ".cm-cursor": { borderLeftColor: "var(--ink)" },
  },
  { dark: true },
);

export interface SourceModeProps {
  /** The raw markdown body being edited (controlled). */
  value: string;
  /** Called on every keystroke with the new raw body. */
  onChange: (next: string) => void;
  /** When true the view is read-only (a locked, not-taken-over doc). */
  readOnly?: boolean;
}

export function SourceMode({ value, onChange, readOnly = false }: SourceModeProps) {
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      theme="dark"
      extensions={[markdown(), theme, EditorView.lineWrapping]}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: false,
      }}
      style={{ width: "100%" }}
    />
  );
}
