// doc-kind — the glyph that marks what KIND a document is (§ spec · ▦ plan · ◇ ADR · ▤ task), derived
// from the doc id alone.
//
// This is what survives of `doc-tree`, which reshaped a run's graph nodes into the deleted Docs
// navigator's three groups (Definition · Decisions · Tasks). The navigator is gone — the run view's tab
// strip does that job — so the grouping went with it; the glyph stayed, because the editor header still
// shows it and it is the one piece the rest of the UI reads.

/** The kind glyph for a doc id. Unknown ids read as a task, the most common kind. */
export function kindGlyphOf(id: string): string {
  if (id === "spec") return "§";
  if (id === "plan") return "▦";
  if (id.startsWith("adr-")) return "◇";
  return "▤";
}
