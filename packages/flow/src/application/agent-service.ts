// AgentService — the agents roster aggregate (spec §3.1 Agents). FLOW *records* an agent's live
// state + assignment against the run-state json; it does NOT dispatch (the native Agent tool
// dispatches). Built over the `RunStore` port (T01) so it is unit-testable without a real FS and the
// run-state field contract lives here (ports.ts: "run-state is loose at this layer; T05 owns its
// field contract"). Plain values cross the port — no fs types leak in.
//
// Run-state shape (this layer owns it): { agents: { "<agent>": { state, assignedTask? } } }. Keyed by
// agent id so a re-recorded state overwrites in place (one entry per agent), and `assignedTask` is
// preserved across a state write (T02 owns the assignment/`lockedBy` write — `agent_state` never
// clobbers it). The service emits typed outcomes the adapter switches on; it never builds an error
// envelope and never throws for an expected failure (mirrors @agentry/memory's service↔adapter seam).
import type { RunStore } from "../domain/ports.js";
import { AgentState } from "../domain/status.js";

// One roster entry as stored/returned. `state` is a validated AgentState; `assignedTask` is the task
// this agent is on (set by the Task family, not here) — optional, absent until assigned.
export interface AgentEntry {
  state: AgentState;
  assignedTask?: string;
}

// The run-state json shape this family owns. Loose `Record` at the port; this is the typed view.
interface AgentRoster {
  agents: Record<string, AgentEntry>;
}

// `agent_state` outcome — a discriminated union the adapter maps to ok/err. `bad-input` carries the
// offending field + the rule it broke (the envelope prose is built at the adapter, not here).
export type AgentStateOutcome =
  | { ok: true; agent: string; state: AgentState }
  | { ok: false; reason: "bad-input"; field: string; rule: string };

export class AgentService {
  constructor(private readonly runs: RunStore) {}

  // Read the current roster from run-state, tolerating a fresh/absent/foreign-shaped file as empty.
  private roster(run: string): AgentRoster {
    const raw = this.runs.readRunState(run);
    const agents = raw?.agents;
    if (typeof agents !== "object" || agents === null) return { agents: {} };
    return { agents: agents as Record<string, AgentEntry> };
  }

  /**
   * Record an agent's live state against the run-state json. Validates `state` against T01's
   * `AgentState` enum (`working | blocked | done`) — an out-of-enum value is REJECTED and NOTHING is
   * written (the rejection precedes any store touch). Per ADR-004, `blocked` is a valid AGENT state
   * here (it is not a task status). Preserves an existing `assignedTask` (T02 owns that write).
   */
  setState(run: string, agent: string, state: string): AgentStateOutcome {
    if (agent.trim().length === 0) {
      return { ok: false, reason: "bad-input", field: "agent", rule: "a non-empty agent id" };
    }
    const parsed = AgentState.safeParse(state);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "bad-input",
        field: "state",
        rule: `one of ${AgentState.options.join(", ")}`,
      };
    }

    const roster = this.roster(run);
    const existing = roster.agents[agent];
    roster.agents[agent] = { ...existing, state: parsed.data };
    this.runs.writeRunState(run, roster as unknown as Record<string, unknown>);
    return { ok: true, agent, state: parsed.data };
  }

  /**
   * The current roster: every recorded agent with its live `state` and optional `assignedTask`. An
   * empty/absent run-state reads as an empty roster (a run with no agents yet is valid, not an error).
   */
  listRoster(run: string): Array<{ agent: string; state: AgentState; assignedTask?: string }> {
    const { agents } = this.roster(run);
    return Object.entries(agents).map(([agent, entry]) => ({
      agent,
      state: entry.state,
      ...(entry.assignedTask !== undefined ? { assignedTask: entry.assignedTask } : {}),
    }));
  }
}
