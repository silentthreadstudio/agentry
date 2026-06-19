// RunService — the run lifecycle + the read-time backstop reconciliation (ADR-002/003/005). Pure of
// MCP: it takes the file-store `FlowServices` and the resolved `cwd`, orchestrates the ports, and
// returns plain values the thin `monitor-tools` adapters serialize. Mirrors @agentry/memory's
// application layer (typed outcomes, no envelope-building here — that lives at the tool boundary).
//
// What it owns:
//  - `start` — the run front door (ADR-005 NO branch): mint <run> via mintRun(goal) when absent, create
//    `.agentry/work/<run>/` + the initial `spec.md` scaffold, and seed the session pointer ONLY when a
//    `session_id` is passed (the server has none of its own; the binder seeds it reactively otherwise).
//  - `emit` — validate `type` against the closed FlowEvent union and append via the EventLog port.
//  - `tail` — read BOTH line shapes via `parseLogLine`, return only the typed FLOW events (the signature
//    promises `FlowEvent[]`); empty-`agent` main-session lines are filtered by `parseLogLine` already.
//  - `status` — at READ TIME, cross-check FLOW node lines against the hook backstop lines and surface
//    `backstopDisagreements` (ADR-003: flag, never block). The hook is unchanged and always exits 0.
import { FlowEvent, parseLogLine } from "../domain/events.js";
import { mintRun } from "../domain/ids.js";
import { writeSessionPointer } from "../resolution/run-pointer.js";
import type { FlowServices } from "../index.js";

// The initial `spec.md` body the front door scaffolds. T02's `artifact_write(spec)` overwrites this
// with the real spec; both stamp `version` the same way (the TaskStore renders the frontmatter), so a
// scaffold and a real write are version-compatible by construction.
const SPEC_SCAFFOLD = [
  "# Spec",
  "",
  "_Scaffolded by run_start. Replace with the real spec via artifact_write(spec)._",
  "",
  "## Job to be done",
  "",
  "## Acceptance criteria",
  "",
].join("\n");

// A reconciliation finding: a hook subagent boundary (a real `agent`) with no matching FLOW node line
// — the skipped-FLOW-call signal AC9 requires. `kind` says which side of the boundary went unmatched.
export interface BackstopDisagreement {
  agent: string;
  kind: "started" | "done";
  ts: string;
  reason: string;
}

// A compact per-status tally of the run's tasks — the "tasks summary" `run_status` returns.
export type TaskSummary = Record<string, number>;

export interface RunStartInput {
  run?: string;
  session_id?: string;
  goal?: string;
}

export class RunService {
  constructor(private readonly services: FlowServices) {}

  // The run front door (ADR-005). Mints <run> when absent, creates the run dir + spec scaffold, and
  // seeds the session pointer ONLY when session_id is passed. Returns the explicit run handle.
  start(input: RunStartInput): { run: string } {
    const run = input.run && input.run.length > 0 ? input.run : mintRun(input.goal ?? "run");

    // Create `.agentry/work/<run>/` (ensureRun mkdirs it) and lay down the initial spec scaffold. The
    // TaskStore stamps the version on write, so the scaffold is artifact_write(spec)-compatible.
    this.services.runs.ensureRun(run);
    this.services.tasks.writeArtifact(run, "spec", SPEC_SCAFFOLD);

    // ADR-005 NO branch: write the session pointer only when the caller supplies session_id. Absent it,
    // the server has no session_id of its own and the binder hook seeds the pointer reactively.
    if (input.session_id && input.session_id.length > 0) {
      writeSessionPointer(this.services.cwd, input.session_id, run);
    }

    return { run };
  }

  // Read the run's live state json (the agent roster + states; T05 owns its field contract). Plain
  // record or `{}` when the run has no state yet — never throws on a missing/corrupt file.
  get(run: string): { run: string; state: Record<string, unknown> } {
    return { run, state: this.services.runs.readRunState(run) ?? {} };
  }

  // Validate `type` against the closed FlowEvent union (AC8) and append via the EventLog port. Returns
  // `{ ok: false }` with the offending field when the event is out-of-union, so the adapter maps it to a
  // bad-input envelope rather than letting the closed union throw.
  emit(run: string, event: unknown): { ok: true } | { ok: false; field: string; rule: string } {
    const parsed = FlowEvent.safeParse(event);
    if (!parsed.success) {
      return {
        ok: false,
        field: "type",
        rule: "one of the closed FlowEvent set (routing-decision | gate | node-enter | node-done)",
      };
    }
    this.services.events.append(run, parsed.data);
    return { ok: true };
  }

  // Read the stream and return ONLY the typed FLOW events (the signature promises `FlowEvent[]`).
  // `parseLogLine` transparently handles both line shapes and drops empty-`agent` main-session lines;
  // hook backstop lines are not FLOW events, so they don't appear in this typed view (they surface via
  // `status`'s reconciliation instead).
  tail(run: string, since?: string): { events: FlowEvent[] } {
    const events: FlowEvent[] = [];
    for (const raw of this.services.events.tail(run, since)) {
      const parsed = parseLogLine(raw);
      if (parsed.kind === "flow") events.push(parsed.event);
    }
    return { events };
  }

  // Read-time backstop reconciliation (ADR-003 — flag, never block). Cross-check the hook's subagent
  // boundaries (real `agent` lines) against FLOW's node lines: a hook `agent-started`/`agent-done` for
  // an agent FLOW emitted no matching `node-enter`/`node-done` for is a disagreement (the skipped-call
  // signal, AC9). Pure read-time computation; nothing is written and nothing blocks.
  status(run: string): { run: string; tasks: TaskSummary; backstopDisagreements: BackstopDisagreement[] } {
    const lines = this.services.events.tail(run);

    // The set of agents FLOW *did* register a node-enter for (the node's `agent` field, when known).
    // node-done carries only `node`, so the node-enter `agent` is the cross-check key for the hook's
    // `agent` boundaries (ADR-002: matched on `agent`).
    const flowEnteredAgents = new Set<string>();
    const flowDoneNodes = new Set<string>();
    const flowEnterNodeByAgent = new Map<string, string>(); // agent -> the node it entered as

    const hookStarted: { agent: string; ts: string }[] = [];
    const hookDone: { agent: string; ts: string }[] = [];

    for (const raw of lines) {
      const parsed = parseLogLine(raw);
      if (parsed.kind === "flow") {
        const ev = parsed.event;
        if (ev.type === "node-enter" && ev.agent) {
          flowEnteredAgents.add(ev.agent);
          flowEnterNodeByAgent.set(ev.agent, ev.node);
        } else if (ev.type === "node-done") {
          flowDoneNodes.add(ev.node);
        }
      } else if (parsed.kind === "hook") {
        // parseLogLine has already dropped empty-/absent-`agent` main-session lines, so any hook line
        // reaching here carries a real subagent `agent` (ADR-002 filter rule).
        const agent = parsed.line.agent;
        if (agent === undefined) continue; // defensive — the filter guarantees a string here
        if (parsed.line.kind === "agent-started") hookStarted.push({ agent, ts: parsed.line.ts });
        else if (parsed.line.kind === "agent-done") hookDone.push({ agent, ts: parsed.line.ts });
      }
    }

    const disagreements: BackstopDisagreement[] = [];

    // A hook agent-started with no FLOW node-enter for that agent → a node the conductor dispatched but
    // skipped the FLOW `node-enter` call for.
    for (const { agent, ts } of hookStarted) {
      if (!flowEnteredAgents.has(agent)) {
        disagreements.push({
          agent,
          kind: "started",
          ts,
          reason: `hook recorded agent-started for "${agent}" but FLOW emitted no node-enter for it (a skipped FLOW call)`,
        });
      }
    }

    // A hook agent-done with no FLOW node-done for the node that agent entered → the node returned per
    // the hook but FLOW never emitted `node-done`. Unknown node (no node-enter seen) also disagrees.
    for (const { agent, ts } of hookDone) {
      const node = flowEnterNodeByAgent.get(agent);
      if (node === undefined || !flowDoneNodes.has(node)) {
        disagreements.push({
          agent,
          kind: "done",
          ts,
          reason: `hook recorded agent-done for "${agent}" but FLOW emitted no matching node-done (a skipped FLOW call)`,
        });
      }
    }

    return { run, tasks: this.summarizeTasks(run), backstopDisagreements: disagreements };
  }

  // Per-status tally of the run's tasks (the "tasks summary"). A loose `status` string is counted
  // under its own key; a task with no/non-string status falls under "unknown".
  private summarizeTasks(run: string): TaskSummary {
    const summary: TaskSummary = {};
    for (const task of this.services.tasks.listTasks(run)) {
      const status = typeof task.frontmatter.status === "string" ? task.frontmatter.status : "unknown";
      summary[status] = (summary[status] ?? 0) + 1;
    }
    return summary;
  }
}
