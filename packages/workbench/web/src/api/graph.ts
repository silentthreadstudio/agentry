// GET /api/work/:id/graph → the dependency/relationship graph for one run (the Panorama canvas).
import type { GraphModel } from "@agentry/workbench-shared";
import { getJson } from "./http.js";

export function fetchGraph(runId: string, signal?: AbortSignal): Promise<GraphModel> {
  return getJson<GraphModel>(`/api/work/${encodeURIComponent(runId)}/graph`, signal);
}
