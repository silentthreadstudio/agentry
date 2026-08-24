// GET /api/work/:id/docs → one run's documents, in reading order (the run view's tab strip).
import type { RunDoc } from "@agentry/workbench-shared";
import { getJson } from "./http.js";

export function fetchDocIndex(runId: string, signal?: AbortSignal): Promise<RunDoc[]> {
  return getJson<RunDoc[]>(`/api/work/${encodeURIComponent(runId)}/docs`, signal);
}
