// GET /api/memory → read-only memory browse (no query) / search (`q`) over both mem roots (the Memory
// page). `MemReadRecord` is the server's view shape (the store's loose fields + the two browse facets:
// which kind, which root) — mirrored narrowly here as the transport shape this read consumes.
import { getJson } from "./http.js";

export interface MemReadRecord {
  id: string;
  fields: Record<string, unknown>;
  kind: "facts" | "episodes";
  origin: "global" | "project";
}

export function fetchMemory(query?: string, signal?: AbortSignal): Promise<MemReadRecord[]> {
  const q = query && query.trim().length > 0 ? `?q=${encodeURIComponent(query.trim())}` : "";
  return getJson<MemReadRecord[]>(`/api/memory${q}`, signal);
}
