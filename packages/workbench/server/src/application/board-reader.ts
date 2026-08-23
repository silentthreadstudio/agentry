// BoardReader — every piece of work in a project, folded into exactly one column (doc 18 §3).
//
// The column is derived HERE, not in the browser. A client that inferred it from a task tally could
// disagree with disk the moment either side changed, and two views of the same run disagreeing is the
// bug this read-model exists to prevent (AC4). PURE of HTTP and of fs: it reads through the backlog
// service and the `WorkReader`, so it is unit-testable with no disk.
//
// ── The one-lifecycle rule ────────────────────────────────────────────────────────────────────────
// `backlog` and `ready` are states of a backlog ITEM. `running` / `in-review` / `done` are derived from
// a RUN's task tally. A card is an item until a session claims it; from then on the card IS the run and
// carries the item id as provenance. There is no ticket→run mapping table, and no card appears twice.
import type { BoardCard, BoardColumn, BoardModel } from "@agentry/workbench-shared";
import type { BacklogItem } from "@agentry/flow/domain/backlog";
import type { WorkReader } from "./work-reader.js";

/** What the reader needs from the backlog — structural, so a fake in a test needs one method. */
export interface BacklogSource {
  list(): BacklogItem[];
}

const EMPTY_COLUMNS = (): Record<BoardColumn, BoardCard[]> => ({
  backlog: [],
  ready: [],
  running: [],
  "in-review": [],
  done: [],
});

export class BoardReader {
  constructor(
    private readonly reader: WorkReader,
    private readonly backlog: BacklogSource,
  ) {}

  read(): BoardModel {
    const columns = EMPTY_COLUMNS();

    // Runs first, indexed by id, so an item can find the run it spawned.
    const runCards = new Map<string, BoardCard>();
    for (const runId of this.reader.listRuns()) {
      const read = this.reader.read(runId);
      if (!read) continue; // vanished between list and read — drop it rather than 500 the board
      const summary = read.summary;
      runCards.set(runId, {
        id: runId,
        column: runColumn(summary.taskCounts),
        title: summary.title,
        origin: "run",
        run: runId,
        ...(summary.kind !== undefined ? { kind: summary.kind } : {}),
        ...(summary.shape !== undefined ? { shape: summary.shape } : {}),
        ...(summary.summary !== undefined ? { summary: summary.summary } : {}),
        taskCounts: summary.taskCounts,
        agentCount: summary.agentCount,
        updatedAt: summary.updatedAt,
      });
    }

    for (const item of this.backlog.list()) {
      // A claimed item hands its card to the run it spawned — the run card carries the provenance and
      // the item does NOT appear again (no card twice).
      const spawned = item.runs.map((r) => runCards.get(r)).find((c) => c !== undefined);
      if (spawned !== undefined) {
        spawned.item = item.id;
        if (spawned.kind === undefined) spawned.kind = item.kind;
        continue;
      }

      // A claimed item whose run is GONE (deleted, or never landed) falls back to `ready`. The intent
      // outliving its run is the reason the item is a separate record at all — losing the card here
      // would silently swallow work someone asked for.
      const column: BoardColumn =
        item.status === "done" ? "done" : item.status === "backlog" ? "backlog" : "ready";

      columns[column].push({
        id: item.id,
        column,
        title: item.title,
        kind: item.kind,
        origin: "item",
        item: item.id,
        updatedAt: item.updatedAt,
      });
    }

    for (const card of runCards.values()) columns[card.column].push(card);

    // Newest first within a column — the same axis the Works list used, so the eye lands where it did.
    for (const column of Object.values(columns)) {
      column.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return { columns };
  }
}

/**
 * A run's column, from its task tally alone.
 *
 *  - anything `in-review` ⇒ the run is waiting on a human, which outranks work still moving: that is
 *    the column you want to look at first.
 *  - every task `done` (and there is at least one) ⇒ done.
 *  - otherwise ⇒ running, INCLUDING a run with no tasks yet. A just-started run is running, not done —
 *    treating "no tasks" as complete would file a fresh run under done the moment it was created.
 */
export function runColumn(counts: Record<string, number>): BoardColumn {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if ((counts["in-review"] ?? 0) > 0) return "in-review";
  if (total > 0 && (counts.done ?? 0) === total) return "done";
  return "running";
}
