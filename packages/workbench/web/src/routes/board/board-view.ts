// board-view — the board's column vocabulary and card view-logic. Pure; no React, no fetch (the same
// view-model split Works/Gates/Activity use), so the ordering and drop rules are unit-testable.
import type { AgentView, BoardCard, BoardColumn, BoardConflict } from "@agentry/workbench-shared";

/** The columns, in lifecycle order. This array IS the board's left-to-right reading order. */
export const COLUMNS: { key: BoardColumn; label: string; hue: string }[] = [
  { key: "backlog", label: "Backlog", hue: "var(--todo)" },
  { key: "ready", label: "Ready", hue: "var(--v1)" },
  { key: "running", label: "Running", hue: "var(--prog)" },
  { key: "in-review", label: "In review", hue: "var(--rev)" },
  { key: "done", label: "Done", hue: "var(--done)" },
];

/**
 * Where a card can be dragged.
 *
 *  - an ITEM moves between Backlog and Ready — those are states of the item itself, one patch away.
 *  - a RUN can be dropped on Ready only, and that means RESET (doc 18 Q2): its tasks go back to `todo`
 *    and its item back to `ready`. Every other column is refused, because a run's column is derived
 *    from its tasks — dropping it elsewhere would ask the board to display something the run is not
 *    doing.
 */
export function canDrop(card: BoardCard, target: BoardColumn): boolean {
  if (card.origin === "item") return target === "backlog" || target === "ready";
  return target === "ready";
}

/** Whether this drop is the reset path — a run going back on the shelf, which needs confirming first. */
export function isReset(card: BoardCard, target: BoardColumn): boolean {
  return card.origin === "run" && target === "ready";
}

/** The confirm text for a reset. Says exactly what happens AND what does not, because "reset" could
 *  reasonably be read as "kill it", and it is not that. */
export function resetPrompt(card: BoardCard): string {
  return `Put "${card.title}" back on the shelf?\n\nIts tasks return to to-do and it can be claimed again. Nothing is deleted, and any agent working right now is not stopped.`;
}

/** Why a drop was refused — shown while the card is still in the air, rather than letting it spring
 *  back unexplained. Uses the column's DISPLAY label: the raw key reads as a verb mid-sentence
 *  ("not running") and names something the user never sees written that way. */
export function refusalReason(card: BoardCard, target: BoardColumn): string {
  const label = COLUMNS.find((c) => c.key === target)?.label ?? target;
  if (card.origin === "run") {
    return `A run's column comes from its tasks. Drop it on Ready to put it back on the shelf, not ${label}.`;
  }
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


/** Initials for an agent avatar — two letters of the role, which is what makes the roster scannable
 *  without a legend (IM implementer, VE verifier, AR architect). */
export function initialsOf(agent: AgentView): string {
  return agent.role.slice(0, 2).toUpperCase();
}

/** How long an agent has been in its current state, as a compact label ("4m", "2h"), or null when the
 *  roster carries no `since` — an elapsed time with no recorded start can only be invented, so we show
 *  nothing rather than guess. */
export function elapsedOf(agent: AgentView, now: number = Date.now()): string | null {
  if (agent.since === undefined) return null;
  const started = Date.parse(agent.since);
  if (Number.isNaN(started)) return null;
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The banner text for a contract overlap. Names the FILE, because that is the thing that will be
 *  clobbered, and the runs, because that is where you go to stop it. */
export function conflictText(conflict: BoardConflict): string {
  const files = conflict.files.join(", ");
  return `${conflict.cards.join(" and ")} are both in progress and both own ${files}. One will clobber the other.`;
}

/** The blocked chip's label, naming the blocker — "blocked by 004" beats a bare "blocked". */
export function blockedLabel(card: BoardCard): string | null {
  const first = card.blocked?.[0];
  if (!first) return null;
  const more = (card.blocked?.length ?? 0) - 1;
  return `blocked by ${first.by.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}
