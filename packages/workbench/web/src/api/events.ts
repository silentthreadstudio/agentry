// The roster + timeline reads. GET /api/events → the folded event timeline (a run's Activity feed, or the
// cross-run feed). GET /api/agents → the agent roster (one run, or across runs) — the live-agent overlay.
import type { AgentView, EventView } from "@agentry/workbench-shared";
import { getJson, runQuery } from "./http.js";

export function fetchEvents(runId?: string, signal?: AbortSignal): Promise<EventView[]> {
  return getJson<EventView[]>(`/api/events${runQuery(runId)}`, signal);
}

export function fetchAgents(runId?: string, signal?: AbortSignal): Promise<AgentView[]> {
  return getJson<AgentView[]>(`/api/agents${runQuery(runId)}`, signal);
}
