// The typed HTTP read-model client. Thin fetch wrappers over the server's PINNED endpoints (task 9):
//   GET /api/works            → RunSummary[]
//   GET /api/work/:id/graph   → GraphModel
//   GET /api/context          → { run?: string }   (the run-id bootstrap for a <id>.localhost host)
// Types come from @agentry/workbench-shared — the one non-drifting read-model contract (ADR-005).
// Every request is relative (base "./" + same-origin) so it resolves behind any *.localhost host the
// local server is reached on.
import type { GraphModel, RunSummary } from "@agentry/workbench-shared";

// The bootstrap context the SPA reads to learn which run (if any) the current host belongs to.
// Bare localhost → no run (Works home); <id>.localhost → that run id.
export interface AppContext {
  run?: string;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new ApiError(`${path} → ${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Every run under .agentry/work/* with its status tally and roster size — the Works home list. */
export function fetchWorks(signal?: AbortSignal): Promise<RunSummary[]> {
  return getJson<RunSummary[]>("/api/works", signal);
}

/** The dependency/relationship graph for one run — consumed by Phase 2's Panorama canvas. */
export function fetchGraph(runId: string, signal?: AbortSignal): Promise<GraphModel> {
  return getJson<GraphModel>(`/api/work/${encodeURIComponent(runId)}/graph`, signal);
}

/**
 * The run-id bootstrap: which run this host belongs to. A `<meta name="agentry-run">` tag (if the
 * server injects one) wins to avoid a round-trip; otherwise we ask /api/context.
 */
export async function fetchContext(signal?: AbortSignal): Promise<AppContext> {
  const meta = document.querySelector('meta[name="agentry-run"]')?.getAttribute("content");
  if (meta) return { run: meta };
  return getJson<AppContext>("/api/context", signal);
}
