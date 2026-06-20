// doc-tree — the PURE transform behind the Docs navigator (task 008). A run's `GraphModel` nodes →
// the grouped document list the left navigator renders: Definition (Spec, Plan) · Decisions (the ADRs) ·
// Tasks (with status dots). Derived from node ids — `spec` / `plan` / `adr-*` / `task-*` — the SAME ids
// the graph and `selectDoc` key on, so a navigator row and a graph node open the identical doc tab.
//
// No React, no I/O — Panorama/the workspace already fetch the graph; this just reshapes it. Kept pure so
// the grouping/ordering is unit-testable without a render (the symmetric of layout-dagre for the canvas).
import type { GraphModel } from "@agentry/workbench-shared";

export type DocGroupKey = "definition" | "decisions" | "tasks";

/** One navigable document in the tree: its id (→ `selectDoc(id)`), the row label, the glyph, and the
 *  FLOW status that drives the status dot (null = no dot, e.g. spec/plan with no lifecycle status). */
export interface DocTreeItem {
  id: string;
  glyph: string;
  label: string;
  status: string | null;
}

export interface DocTreeGroup {
  key: DocGroupKey;
  /** The section heading ("Definition" · "Decisions · 7" · "Tasks · 27"). */
  heading: string;
  items: DocTreeItem[];
}

// The header/row glyph for a doc id (mirrors DocNode.kindViewOf so the navigator, the graph card, and the
// editor header all show the same kind glyph). Exported for the editor header to reuse.
export function kindGlyphOf(id: string): string {
  if (id === "spec") return "§";
  if (id === "plan") return "▦";
  if (id.startsWith("adr-")) return "◇";
  if (id.startsWith("task-")) return "▤";
  return "▤";
}

// The row label for a doc id + its server graph label. Spec/Plan read as their kind; an ADR/Task reads as
// "<key> · <title>" (the id key plus the human title stripped from the server label) — the mockup's form.
function rowLabel(id: string, serverLabel: string): string {
  if (id === "spec") return "Spec";
  if (id === "plan") return "Plan";
  if (id.startsWith("adr-")) {
    const key = id.slice("adr-".length);
    const colon = serverLabel.indexOf(":");
    const title = colon >= 0 ? serverLabel.slice(colon + 1).trim() : serverLabel;
    return title ? `${key} · ${title}` : key;
  }
  if (id.startsWith("task-")) {
    const key = id.slice("task-".length);
    const space = serverLabel.indexOf(" ");
    const title = space >= 0 ? serverLabel.slice(space + 1).trim() : serverLabel;
    return title ? `${key} · ${title}` : key;
  }
  return serverLabel || id;
}

function groupOf(id: string): DocGroupKey | null {
  if (id === "spec" || id === "plan") return "definition";
  if (id.startsWith("adr-")) return "decisions";
  if (id.startsWith("task-")) return "tasks";
  return null; // routing root / synthetic group ids are not documents
}

// Definition order: Spec before Plan (the production order), regardless of graph node order.
const DEFINITION_ORDER = ["spec", "plan"];
function definitionRank(id: string): number {
  const i = DEFINITION_ORDER.indexOf(id);
  return i === -1 ? DEFINITION_ORDER.length : i;
}

/**
 * Reshape a run's GraphModel into the navigator's three groups. Pure: the model is read, never mutated.
 * Empty groups are dropped (a run with no ADRs shows no Decisions section). Definition is Spec→Plan;
 * Decisions and Tasks keep the graph's node order (the server's production order).
 */
export function buildDocTree(model: GraphModel): DocTreeGroup[] {
  const definition: DocTreeItem[] = [];
  const decisions: DocTreeItem[] = [];
  const tasks: DocTreeItem[] = [];

  for (const node of model.nodes) {
    const group = groupOf(node.id);
    if (group === null) continue;
    const item: DocTreeItem = {
      id: node.id,
      glyph: kindGlyphOf(node.id),
      label: rowLabel(node.id, node.label),
      status: node.status ?? null,
    };
    if (group === "definition") definition.push(item);
    else if (group === "decisions") decisions.push(item);
    else tasks.push(item);
  }

  definition.sort((a, b) => definitionRank(a.id) - definitionRank(b.id));

  const groups: DocTreeGroup[] = [];
  if (definition.length > 0) {
    groups.push({ key: "definition", heading: "Definition", items: definition });
  }
  if (decisions.length > 0) {
    groups.push({ key: "decisions", heading: `Decisions · ${decisions.length}`, items: decisions });
  }
  if (tasks.length > 0) {
    groups.push({ key: "tasks", heading: `Tasks · ${tasks.length}`, items: tasks });
  }
  return groups;
}

/** The flat, ordered list of all doc ids in the tree — the "Review all docs" walk-through sequence. */
export function docOrder(model: GraphModel): string[] {
  return buildDocTree(model).flatMap((g) => g.items.map((i) => i.id));
}
