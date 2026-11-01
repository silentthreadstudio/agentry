// RunService — the run lifecycle + the read-time task summary (ADR-002/005). Pure of
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
//  - `status` — at READ TIME, the per-status task summary.
import { FlowEvent, parseLogLine } from "../domain/events.js";
import { mintRun } from "../domain/ids.js";
import type { FlowServices } from "../index.js";
import { writeSessionPointer } from "../resolution/run-pointer.js";

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
      // Attribute the failure to the field that actually failed, not always the `type` discriminator:
      // a discriminated-union mismatch surfaces an issue whose `path` names the offending key (e.g.
      // ["shape"]). Only a bad/absent discriminator yields an empty `path` → then it really is `type`.
      const issue = parsed.error.issues[0];
      const field = issue && issue.path.length > 0 ? String(issue.path[0]) : "type";
      const rule =
        field === "type"
          ? "one of the closed FlowEvent set (routing-decision | gate | node-enter | node-done)"
          : (issue?.message ?? "the value required by the FlowEvent schema for this type");
      return { ok: false, field, rule };
    }
    this.services.events.append(run, parsed.data);
    return { ok: true };
  }

  // Read the stream and return ONLY the typed FLOW events (the signature promises `FlowEvent[]`).
  // `parseLogLine` transparently handles both line shapes and drops empty-`agent` main-session lines;
  // legacy backstop lines (an old stream may still hold them) are not FLOW events, so they don't appear.
  tail(run: string, since?: string): { events: FlowEvent[] } {
    const events: FlowEvent[] = [];
    for (const raw of this.services.events.tail(run, since)) {
      const parsed = parseLogLine(raw);
      if (parsed.kind === "flow") events.push(parsed.event);
    }
    return { events };
  }

  // Read-time run health: the per-status task tally.
  status(run: string): { run: string; tasks: TaskSummary } {
    return { run, tasks: this.summarizeTasks(run) };
  }

  // Per-status tally of the run's tasks (the "tasks summary"). A loose `status` string is counted
  // under its own key; a task with no/non-string status falls under "unknown".
  private summarizeTasks(run: string): TaskSummary {
    const summary: TaskSummary = {};
    for (const task of this.services.tasks.listTasks(run)) {
      const status =
        typeof task.frontmatter.status === "string" ? task.frontmatter.status : "unknown";
      summary[status] = (summary[status] ?? 0) + 1;
    }
    return summary;
  }
}
