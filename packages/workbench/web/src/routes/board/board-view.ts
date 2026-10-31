// board-view — the board's column vocabulary and card view-logic. Pure; no React, no fetch (the same
// view-model split Works/Gates/Activity use), so the ordering and drop rules are unit-testable.
import type {
  AgentView,
  BoardCard,
  BoardColumn,
  BoardConflict,
  RunDoc,
} from "@agentry/workbench-shared";
import { workSlug } from "@agentry/workbench-shared";

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

/**
 * Where ←/→ moves a focused card — the keyboard equivalent of a drag.
 *
 * Drag-and-drop is mouse-only, so without this the board's one write action is unreachable by keyboard:
 * you could tab to every card and open it, and never move one. It walks COLUMNS from where the card is
 * and returns the first column in that direction the card is actually allowed to enter (so an item in
 * Backlog goes → Ready, and a run — which may only go back to Ready — reaches it from anywhere), or null
 * when there is nowhere to go, which is what tells the caller to do nothing rather than beep.
 */
export function keyboardTarget(card: BoardCard, dir: -1 | 1): BoardColumn | null {
  const from = COLUMNS.findIndex((c) => c.key === card.column);
  if (from < 0) return null;
  for (let i = from + dir; i >= 0 && i < COLUMNS.length; i += dir) {
    const col = COLUMNS[i];
    if (col !== undefined && canDrop(card, col.key)) return col.key;
  }
  return null;
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
const COUNT_ORDER: { key: "in-progress" | "in-review" | "todo" | "done"; label: string }[] = [
  { key: "in-progress", label: "in progress" },
  { key: "in-review", label: "in review" },
  { key: "todo", label: "to do" },
  { key: "done", label: "done" },
];

export function countChips(card: BoardCard): { label: string; n: number }[] {
  if (!card.taskCounts) return [];
  return COUNT_ORDER.map((c) => ({ label: c.label, n: card.taskCounts?.[c.key] ?? 0 })).filter(
    (c) => c.n > 0,
  );
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

/** A compact relative age ("just now", "4m ago", "2d ago"). The mock's cards carry one on every column
 *  and it is not decoration: a backlog item added six weeks ago and one added this morning are different
 *  things, and a board that shows neither makes you open both to find out. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
}

/** The trailing note on a card, which differs by column because the useful fact differs: an item's age,
 *  a queued item's position, a blocked run's state, a shipped run's ship time. */
export function cardNote(card: BoardCard, now?: number): string {
  const when = relativeTime(card.updatedAt, now);
  switch (card.column) {
    case "backlog":
      return when === "" ? "" : `added ${when}`;
    case "ready":
      return "picks up next";
    case "in-review":
      return "waiting on you";
    case "done":
      return when === "" ? "" : `shipped ${when}`;
    default:
      return card.blocked !== undefined && card.blocked.length > 0 ? "waiting" : when;
  }
}

/** The in-app PATH a run opens at: `/work/<workSlug>`. The slug is the short, stable label both halves
 *  compute; the server resolves it back to the full run id.
 *
 *  A path, not a host, and that is the whole point: addressing a run by subdomain made every run its own
 *  ORIGIN (a reload, a fresh socket, its own storage) and it silently broke — browsers lower-case the
 *  Host header, so any run id with an uppercase character resolved to no run at all. */
export function runHref(runId: string): string {
  return `/work/${encodeURIComponent(workSlug(runId))}`;
}

/** The task a run is currently on — the one an agent holds, else the lowest-numbered unfinished one.
 *  The mock shows it because "which task is this run actually on" is the question a running card raises
 *  and a progress bar alone cannot answer. */
export function currentTask(card: BoardCard): string | null {
  const held = card.agents?.find((a) => a.task !== null && a.task !== undefined)?.task;
  if (held) return `T-${held.replace(/^task-/, "")}`;
  const blocked = card.blocked?.[0]?.task;
  return blocked ? `T-${blocked}` : null;
}

/** Assignments folded by agent: one row per person, listing their tasks. Three identical
 *  "implementer · assigned T-00x" lines say the same thing three times and push the rest of the card
 *  off screen; "implementer · assigned T-001, T-002, T-003" says it once. */
export function assignedByAgent(card: BoardCard): { to: string; tasks: string[] }[] {
  const byAgent = new Map<string, string[]>();
  for (const a of card.assigned ?? []) {
    byAgent.set(a.to, [...(byAgent.get(a.to) ?? []), a.task]);
  }
  return [...byAgent].map(([to, tasks]) => ({ to, tasks: tasks.sort() }));
}

/** The run view's tab label — the human reading of a doc, where the strip used to print the raw id.
 *
 *  Spec and Plan read as their kind; an ADR or a task reads as "<key> · <title>", taking the key from the
 *  id (which is canonical) and the title from the server label, which prefixes it with the same key in a
 *  machine form ("adr ADR-001: …", "001 …") that would otherwise be printed twice.
 *
 *  A titleless document collapses to the bare key, and it reaches that state two different ways. An
 *  EMPTY `title:` leaves the split empty, so the tab would read "ADR-001 · " with nothing after it. A
 *  MISSING `title:` is worse: the server substitutes the key as the title, so the tab would read
 *  "ADR-001 · ADR-001" — a separator earning its keep by repeating what it separates. Both are the same
 *  fact (this document has no title) and both should read the same way.
 *
 *  An unknown id falls through to the server label, because a doc kind we do not know how to abbreviate
 *  is still better named by the server than by its id — and to the id when even that is empty, since a
 *  tab with no text at all cannot be clicked on purpose. */
export function docTabLabel(doc: RunDoc): string {
  if (doc.id === "spec") return "Spec";
  if (doc.id === "plan") return "Plan";
  if (doc.id.startsWith("adr-")) {
    const key = doc.id.slice("adr-".length);
    const colon = doc.label.indexOf(":");
    const title = colon >= 0 ? doc.label.slice(colon + 1).trim() : doc.label;
    return title && title !== key ? `${key} · ${title}` : key;
  }
  if (doc.id.startsWith("task-")) {
    const key = doc.id.slice("task-".length);
    const space = doc.label.indexOf(" ");
    const title = space >= 0 ? doc.label.slice(space + 1).trim() : doc.label;
    return title && title !== key ? `${key} · ${title}` : key;
  }
  return doc.label || doc.id;
}
