// EventStore — the ONE timeline fold (plan §2.2). Folds every run's `events.jsonl` (+ the hook backstop
// lines) into a single `EventView[]` projection that powers BOTH the per-work Activity feed (filtered to
// one run) and the cross-run Agents view — a projection, NOT five ad-hoc scanners. Also derives the agent
// roster (`AgentView[]`) from each run's `run-state.json`. PURE of HTTP/ws AND of fs (ADR-001): it depends
// only on the `WorkRepository` (for the run list) + the `EventSource` port (for the two run-level files),
// so it is unit-testable against a fake source with no disk, and the transport edge serves it without
// re-reading the disk.
//
// ── Reuse, not fork (ADR-005 tier 1) ─────────────────────────────────────────────────────────────────
// Event parsing is FLOW's: `parseLogLine` discriminates the two `events.jsonl` line shapes (FLOW events
// vs. the `subagent-emit` hook backstop) and DROPS empty-`agent` main-session lines. We never reimplement
// that — a malformed line is already a `skip`, so the fold tolerates a corrupt stream past one bad entry.
// The roster is read off `run-state.json`'s `{ agents: { "<id>": { state, assignedTask? } } }` shape (the
// same shape FLOW's `AgentService` owns), validated through FLOW's closed `AgentState` enum.
import type { AgentView, EventView } from "@agentry/workbench-shared";
import type { FlowEvent, HookBackstopLine } from "@agentry/flow/domain/events";
import { parseLogLine } from "@agentry/flow/domain/events";
import { AgentState } from "@agentry/flow/domain/status";
import type { EventSource, WorkRepository } from "../domain/ports.js";

export class EventStore {
  // The run list comes from the repository (the SAME `.agentry/work/` listing the Works home uses, so the
  // fold and the Works list never disagree about which runs exist); the two run-level files come from the
  // injected `EventSource` port — no fs here, the adapter owns the bytes (ADR-001).
  constructor(
    private readonly repository: WorkRepository,
    private readonly source: EventSource,
  ) {}

  // The one fold. With no `runId`, fold EVERY run's events into a single cross-run timeline (the Agents
  // projection); with a `runId`, fold ONLY that run (the per-work Activity feed). Both come from the SAME
  // projection — the only difference is the set of runs scanned. Events arrive in file order per run; the
  // cross-run timeline concatenates runs in `listRuns` order (sorted, stable).
  timeline(runId?: string): EventView[] {
    const runs = runId !== undefined ? [runId] : this.repository.listRuns();
    const views: EventView[] = [];
    for (const run of runs) {
      this.foldRun(run, views);
    }
    return views;
  }

  // The agent roster across runs (or one run): every recorded agent with its FLOW live state and the task
  // it is on. Read from each run's `run-state.json`; a fresh/absent/foreign-shaped file contributes no
  // agents (a run with no roster yet is valid, not an error). The view `id` is namespaced by run so the
  // same agent role in two runs stays distinct in the cross-run view.
  roster(runId?: string): AgentView[] {
    const runs = runId !== undefined ? [runId] : this.repository.listRuns();
    const views: AgentView[] = [];
    for (const run of runs) {
      for (const entry of this.rosterOf(run)) {
        views.push({
          id: `${run}/${entry.agent}`,
          role: entry.agent,
          state: entry.state,
          task: entry.assignedTask ?? null,
        });
      }
    }
    return views;
  }

  // Fold one run's `events.jsonl` lines into the accumulator. Each kept line becomes one `EventView` with a
  // stable feed key (run + line index — unique within the fold, stable across reads of an unchanged file).
  // A line `parseLogLine` skips (blank, malformed, or an empty-`agent` main-session hook line) is dropped.
  // A hook backstop line is projected into the closed `node-enter` shape so the feed renders one event
  // vocabulary — its `kind` becomes the node label, its `agent` the actor (the hook's only structured fields).
  private foldRun(run: string, into: EventView[]): void {
    this.source.eventLines(run).forEach((line, index) => {
      const parsed = parseLogLine(line);
      if (parsed.kind === "skip") return;
      const event = parsed.kind === "flow" ? parsed.event : hookToEvent(parsed.line);
      into.push({ id: `${run}#${index}`, event });
    });
  }

  // Derive one run's roster from the source's parsed `run-state.json`. A corrupt/absent file (the source
  // returns `undefined`), or one whose `agents` isn't an object, yields no entries. Each agent's `state` is
  // validated through FLOW's closed `AgentState` — an out-of-enum value drops that agent rather than
  // surfacing an ill-typed state.
  private rosterOf(run: string): Array<{ agent: string; state: AgentState; assignedTask?: string }> {
    const raw = this.source.runState(run);
    const agents = isRecord(raw) ? raw.agents : undefined;
    if (!isRecord(agents)) return [];

    const out: Array<{ agent: string; state: AgentState; assignedTask?: string }> = [];
    for (const [agent, value] of Object.entries(agents)) {
      if (!isRecord(value)) continue;
      const state = AgentState.safeParse(value.state);
      if (!state.success) continue;
      const assignedTask = typeof value.assignedTask === "string" ? value.assignedTask : undefined;
      out.push({ agent, state: state.data, ...(assignedTask !== undefined ? { assignedTask } : {}) });
    }
    return out;
  }
}

// Project a hook backstop line into the closed FLOW event vocabulary so the feed renders ONE shape. The
// hook carries only `kind` + `agent` (the empty-`agent` ones are already dropped upstream), so we map it
// to a `node-enter` whose `node` is the hook `kind` and whose `agent` is the actor. `ts` carries through.
function hookToEvent(line: HookBackstopLine): FlowEvent {
  return { ts: line.ts, type: "node-enter", node: line.kind, agent: line.agent };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
