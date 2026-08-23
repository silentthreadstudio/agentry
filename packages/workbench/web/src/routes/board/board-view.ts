// board-view — the board's column vocabulary and card view-logic. Pure; no React, no fetch (the same
// view-model split Works/Gates/Activity use), so the ordering and drop rules are unit-testable.
import type { BoardCard, BoardColumn } from "@agentry/workbench-shared";

/** The columns, in lifecycle order. This array IS the board's left-to-right reading order. */
export const COLUMNS: { key: BoardColumn; label: string; hue: string }[] = [
  { key: "backlog", label: "Backlog", hue: "var(--todo)" },
  { key: "ready", label: "Ready", hue: "var(--v1)" },
  { key: "running", label: "Running", hue: "var(--prog)" },
  { key: "in-review", label: "In review", hue: "var(--rev)" },
  { key: "done", label: "Done", hue: "var(--done)" },
];

/** Where a card can be dragged. Only an ITEM moves between backlog and ready — those are states of the
 *  item itself, a patch away. A run's column is DERIVED from its tasks, so dragging a run card would be
 *  asking the board to lie about what the run is doing; the drop is refused with a reason instead. */
export function canDrop(card: BoardCard, target: BoardColumn): boolean {
  if (card.origin !== "item") return false;
  return target === "backlog" || target === "ready";
}

/** Why a drop was refused — shown while the card is still in the air, rather than letting it spring
 *  back unexplained. Uses the column's DISPLAY label: the raw key reads as a verb mid-sentence
 *  ("not running") and names something the user never sees written that way. */
export function refusalReason(card: BoardCard, target: BoardColumn): string {
  if (card.origin === "run") {
    return "A run's column comes from its tasks — move the work, not the card.";
  }
  const label = COLUMNS.find((c) => c.key === target)?.label ?? target;
  return `An item can only sit in Backlog or Ready, not ${label}.`;
}

/** The progress fraction of a run card (0..1), or null for an item (which has no tasks yet). */
export function progressOf(card: BoardCard): number | null {
  if (!card.taskCounts) return null;
  const counts = Object.values(card.taskCounts);
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  return (card.taskCounts.done ?? 0) / total;
}

/** The count chips a run card shows — lifecycle order, zeroes omitted. */
export const COUNT_ORDER: { key: "in-progress" | "in-review" | "todo" | "done"; label: string }[] = [
  { key: "in-progress", label: "in progress" },
  { key: "in-review", label: "in review" },
  { key: "todo", label: "to do" },
  { key: "done", label: "done" },
];

export function countChips(card: BoardCard): { label: string; n: number }[] {
  if (!card.taskCounts) return [];
  return COUNT_ORDER.map((c) => ({ label: c.label, n: card.taskCounts?.[c.key] ?? 0 })).filter((c) => c.n > 0);
}

/** Total cards on the board — the header's "N pieces of work". */
export function totalCards(columns: Record<BoardColumn, BoardCard[]>): number {
  return Object.values(columns).reduce((sum, list) => sum + list.length, 0);
}
