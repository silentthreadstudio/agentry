// GET /api/works → every run under .agentry/work/* with its status tally + roster size (the Works home).
import type { RunSummary } from "@agentry/workbench-shared";
import { getJson } from "./http.js";

export function fetchWorks(signal?: AbortSignal): Promise<RunSummary[]> {
  return getJson<RunSummary[]>("/api/works", signal);
}
