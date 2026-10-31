import type { BacklogItem } from "@agentry/flow/domain/backlog";
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
import type {
  AgentView,
  BoardCard,
  BoardColumn,
  BoardConflict,
  BoardModel,
} from "@agentry/workbench-shared";
import { parseContract, sharedFiles } from "../domain/contract.js";
import type { ReaderDoc, WorkReader } from "./work-reader.js";

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

/** The roster source — FLOW's own, injected so presence has exactly ONE origin (AC9). */
export interface RosterSource {
  roster(runId?: string): AgentView[];
}

/** A task as the overlap/blocking passes see it: its number, status, and declared contract. */
interface TaskFacts {
  run: string;
  taskNo: string;
  status: string;
  owns: string[];
  deps: string[];
  /** The agent the Task family assigned this to, if any (FLOW's `lockedBy`). */
  lockedBy?: string;
}

export class BoardReader {
  constructor(
    private readonly reader: WorkReader,
    private readonly backlog: BacklogSource,
    private readonly roster?: RosterSource,
  ) {}

  read(): BoardModel {
    const columns = EMPTY_COLUMNS();
    const allTasks: TaskFacts[] = [];

    // Runs first, indexed by id, so an item can find the run it spawned.
    const runCards = new Map<string, BoardCard>();
    for (const runId of this.reader.listRuns()) {
      const read = this.reader.read(runId);
      if (!read) continue; // vanished between list and read — drop it rather than 500 the board
      const summary = read.summary;
      const tasks = taskFactsOf(runId, read.docs);
      allTasks.push(...tasks);
      const blocked = blockedIn(tasks);
      const assigned = assignedIn(tasks);
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
        ...(blocked.length > 0 ? { blocked } : {}),
        ...(assigned.length > 0 ? { assigned } : {}),
        updatedAt: summary.updatedAt,
      });
    }

    // Presence: who is on which run, straight from FLOW's roster (AC9 — no second source of agent
    // truth). Each agent is joined to the first file its task declares, which is the one thing worth
    // showing beside a live agent: who is touching what.
    if (this.roster !== undefined) {
      const byRun = new Map<string, AgentView[]>();
      for (const agent of this.roster.roster()) {
        const run = agent.id.split("/")[0] ?? "";
        const file = agent.task === null ? undefined : ownsOf(allTasks, run, agent.task)[0];
        const view: AgentView = { ...agent, ...(file !== undefined ? { file } : {}) };
        byRun.set(run, [...(byRun.get(run) ?? []), view]);
      }
      for (const [run, agents] of byRun) {
        const card = runCards.get(run);
        if (!card) continue;
        card.agents = agents;
        // An agent that is actually PRESENT outranks its own assignment row — otherwise a working agent
        // would appear twice, once live and once as "assigned".
        const present = new Set(agents.map((a) => a.role));
        const stillWaiting = (card.assigned ?? []).filter((a) => !present.has(a.to));
        if (stillWaiting.length > 0) card.assigned = stillWaiting;
        // biome-ignore lint/performance/noDelete: the key must be absent, not undefined — board JSON and deepEqual consumers distinguish them
        else delete card.assigned;
      }
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

    // Contract overlap, board-wide. Two agents in two DIFFERENT runs editing one file is the case that
    // actually bites, so this is not scoped within a run.
    const conflicts = overlapsAmong(allTasks);
    for (const conflict of conflicts) {
      for (const id of conflict.cards) {
        const card = runCards.get(id);
        if (card) card.conflict = true;
      }
    }

    for (const card of runCards.values()) columns[card.column].push(card);

    // Newest first within a column — the same axis the Works list used, so the eye lands where it did.
    for (const column of Object.values(columns)) {
      column.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return { columns, conflicts };
  }
}

// ── the two overlays ────────────────────────────────────────────────────────────────────────────────

/** Parse each task doc into the facts the overlays need. `deps` merges both places the planner writes
 *  them: FLOW's frontmatter and the `## Contract` block. */
function taskFactsOf(run: string, docs: readonly ReaderDoc[]): TaskFacts[] {
  const facts: TaskFacts[] = [];
  for (const doc of docs) {
    if (!doc.id.startsWith("task-")) continue;
    const contract = parseContract(doc.body);
    const frontDeps = Array.isArray(doc.frontmatter.deps)
      ? doc.frontmatter.deps.map((d) => String(d))
      : [];
    const lockedBy =
      typeof doc.frontmatter.lockedBy === "string" ? doc.frontmatter.lockedBy : undefined;
    facts.push({
      run,
      taskNo: doc.id.slice("task-".length),
      status: typeof doc.frontmatter.status === "string" ? doc.frontmatter.status : "todo",
      owns: contract.owns,
      ...(lockedBy !== undefined ? { lockedBy } : {}),
      deps: [...new Set([...frontDeps, ...contract.deps])].map(normalizeTaskNo).filter(Boolean),
    });
  }
  return facts;
}

/** `deps: [1, 3]` and `deps: ["003"]` both mean task 003 — the same normalization buildGraph does. */
function normalizeTaskNo(raw: string): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  return /^\d+$/.test(trimmed) ? trimmed.padStart(3, "0") : trimmed;
}

/** Tasks whose deps are not all done, with the blockers holding them. A dep that names no known task is
 *  ignored rather than reported as a blocker — a typo should not invent a blockage. */
function blockedIn(tasks: readonly TaskFacts[]): { task: string; by: string[] }[] {
  const byNo = new Map(tasks.map((t) => [t.taskNo, t]));
  const blocked: { task: string; by: string[] }[] = [];
  for (const task of tasks) {
    if (task.status === "done") continue;
    const by = task.deps.filter((d) => {
      const dep = byNo.get(d);
      return dep !== undefined && dep.status !== "done";
    });
    if (by.length > 0) blocked.push({ task: task.taskNo, by });
  }
  return blocked;
}

/** Tasks that have been GIVEN to an agent but whose agent is not working yet. Dispatch and the agent's
 *  first write are seconds to minutes apart, and in that window a card with nothing on it reads as
 *  "nobody is on this" when somebody already is. */
function assignedIn(tasks: readonly TaskFacts[]): { task: string; to: string }[] {
  return tasks
    .filter((t) => t.lockedBy !== undefined && t.status !== "done")
    .map((t) => ({ task: t.taskNo, to: t.lockedBy as string }));
}

/** Every pair of CONCURRENT tasks (both in-progress) whose owns sets intersect. Only in-progress
 *  counts: two tasks that own the same file but run at different times are a sequence, not a clobber. */
function overlapsAmong(tasks: readonly TaskFacts[]): BoardConflict[] {
  const live = tasks.filter((t) => t.status === "in-progress" && t.owns.length > 0);
  const conflicts: BoardConflict[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (a === undefined || b === undefined) continue;
      const files = sharedFiles(a.owns, b.owns);
      if (files.length === 0) continue;
      conflicts.push({
        files,
        cards: [...new Set([a.run, b.run])],
        tasks: [`${a.run}/${a.taskNo}`, `${b.run}/${b.taskNo}`],
      });
    }
  }
  return conflicts;
}

/** The files a given run's task declares. */
function ownsOf(tasks: readonly TaskFacts[], run: string, taskRef: string): string[] {
  const no = normalizeTaskNo(taskRef.replace(/^task-/, ""));
  return tasks.find((t) => t.run === run && t.taskNo === no)?.owns ?? [];
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
