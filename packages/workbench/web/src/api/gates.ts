// GET /api/gates → the open waiting-on-you gate items, each carrying its run for the jump-to-doc-at-gate.
// `OpenGateItem` is the server's view extension of the shared `GateItem` (+ its run) — mirrored narrowly
// here as the transport shape this read consumes (a drift surfaces at the Gates page, not silently).
import type { GateItem } from "@agentry/workbench-shared";
import { getJson, runQuery } from "./http.js";

export interface OpenGateItem extends GateItem {
  run: string;
}

export function fetchGates(runId?: string, signal?: AbortSignal): Promise<OpenGateItem[]> {
  return getJson<OpenGateItem[]>(`/api/gates${runQuery(runId)}`, signal);
}
