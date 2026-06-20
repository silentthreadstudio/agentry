// The typed HTTP read-model client. Thin fetch wrappers over the server's PINNED endpoints (task 9):
//   GET /api/works            → RunSummary[]
//   GET /api/work/:id/graph   → GraphModel
//   GET /api/context          → { run?: string }   (the run-id bootstrap for a <id>.localhost host)
// Types come from @agentry/workbench-shared — the one non-drifting read-model contract (ADR-005).
// Every request is relative (base "./" + same-origin) so it resolves behind any *.localhost host the
// local server is reached on.
//
// ── The Phase-4 reader surface (additive — tasks 20/21 pinned these endpoints) ─────────────────────────
// Five more reads back the Activity / Agents / Gates / Tokens / Memory pages. EventView / AgentView /
// GateItem / TokenSeries are in the shared read-model contract (imported below). Two response shapes are
// the server's *view extensions* of those contracts — `OpenGateItem` (a GateItem + its run, the jump
// target) and `MemReadRecord` (a memory record + its browse facets) — and live server-side only (not in
// shared). Rather than import across the server/web boundary, the web client mirrors those two extra
// fields here, narrowly, as the transport shape it consumes. A drift in either shape surfaces at the
// consuming page, not silently — the shared GateItem/`fields` halves still come from the one contract.
import type {
  AgentView,
  EventView,
  GateItem,
  GraphModel,
  RunSummary,
  TokenSeries,
} from "@agentry/workbench-shared";
export type { AgentView, EventView, GateItem, TokenSeries } from "@agentry/workbench-shared";

/** A gate inbox item plus the run it lives in — the jump-to-doc-at-gate target (server `OpenGateItem`). */
export interface OpenGateItem extends GateItem {
  run: string;
}

/** A read-only memory record as the Memory page browses it (server `MemReadRecord`): the store's loose
 *  fields plus the two browse facets — which kind it is and which root it came from. */
export interface MemReadRecord {
  id: string;
  fields: Record<string, unknown>;
  kind: "facts" | "episodes";
  origin: "global" | "project";
}

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

// ── Phase-4 reader fetchers ───────────────────────────────────────────────────────────────────────────
const runQuery = (runId?: string) => (runId ? `?run=${encodeURIComponent(runId)}` : "");

/** The folded event timeline. With a runId → that run's Activity feed; without → the cross-run feed. */
export function fetchEvents(runId?: string, signal?: AbortSignal): Promise<EventView[]> {
  return getJson<EventView[]>(`/api/events${runQuery(runId)}`, signal);
}

/** The agent roster across runs (or one run when `runId` is given) — the Agents page. */
export function fetchAgents(runId?: string, signal?: AbortSignal): Promise<AgentView[]> {
  return getJson<AgentView[]>(`/api/agents${runQuery(runId)}`, signal);
}

/** The open waiting-on-you gate items, each carrying its run for the jump-to-doc-at-gate. */
export function fetchGates(runId?: string, signal?: AbortSignal): Promise<OpenGateItem[]> {
  return getJson<OpenGateItem[]>(`/api/gates${runQuery(runId)}`, signal);
}

/** The per-day cumulative token series for one run (may be an empty series — degrade gracefully). */
export function fetchTokens(runId: string, signal?: AbortSignal): Promise<TokenSeries> {
  return getJson<TokenSeries>(`/api/tokens?run=${encodeURIComponent(runId)}`, signal);
}

/** Read-only memory browse (no query) / search (`q`) over both mem roots — the Memory page. */
export function fetchMemory(query?: string, signal?: AbortSignal): Promise<MemReadRecord[]> {
  const q = query && query.trim().length > 0 ? `?q=${encodeURIComponent(query.trim())}` : "";
  return getJson<MemReadRecord[]>(`/api/memory${q}`, signal);
}
