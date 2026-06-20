// reader-routes — the Phase-4 aggregation read surface (ADR-001). ADDITIVE to the Phase-1 GET surface in
// `read-routes` — a SEPARATE dispatcher so task 9's pinned reads stay untouched; the http layer tries it
// after `handleApiRequest` returns false. All are GET-only (a write verb is 405, never a silent
// fall-through). Host-scoped where it matters: `/api/events`, `/api/gates`, `/api/tokens` accept
// `?run=<id>` to filter to one run; absent the param they fold across every run (the cross-run view).
//
//   GET /api/events[?run=<id>]  → EventView[]   — the folded timeline (one fold powers Activity + Agents)
//   GET /api/agents[?run=<id>]  → AgentView[]   — the agent roster across runs (or one run)
//   GET /api/gates[?run=<id>]   → OpenGateItem[] — the open waiting-on-you gate items
//   GET /api/tokens?run=<id>    → TokenSeries   — the per-day token series for one run (empty if absent)
//   GET /api/memory[?q=<text>]  → MemReadRecord[] — read-only browse/search over both mem roots
//   GET /api/work/:id/review/:docId → ReviewComment[] — one doc's on-disk review comments (gate == docId)
//
// These services are PURE of HTTP (ADR-001) — the handlers below are thin adapters that call them and
// serialize JSON, holding no run state of their own.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReviewComment } from "@agentry/flow/domain/review";
import type { EventStore } from "../application/event-store.js";
import type { GateInbox } from "../application/gate-inbox.js";
import type { TokenReader } from "../application/token-reader.js";
import type { MemReader } from "../persistence/mem-reader.js";
import { guardGet, sendJson } from "./http-kit.js";
import { matchWorkReview, runParam } from "./route-match.js";

// The Phase-4 read-aggregation services the five reader GET handlers fold (event-store/gate-inbox/
// token-reader/mem-reader). Threaded by the composition root alongside the `WorkReader`, the same DI
// pattern task 9 uses.
export interface ReaderDeps {
  events: EventStore;
  gates: GateInbox;
  tokens: TokenReader;
  memory: MemReader;
}

export function handleReaderRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReaderDeps,
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // The `?run=<id>` filter (events/agents/gates/tokens). Undefined ⇒ the cross-run fold; a present value is
  // the run to scope to. The run-segment safety is the store's `runDir` guard (`assertSafeSegment`), not
  // this matcher — an empty `?run=` is treated as absent.
  const run = runParam(url);

  if (path === "/api/events") {
    return guardGet(method, res, () => sendJson(res, 200, deps.events.timeline(run)));
  }
  if (path === "/api/agents") {
    return guardGet(method, res, () => sendJson(res, 200, deps.events.roster(run)));
  }
  if (path === "/api/gates") {
    return guardGet(method, res, () => sendJson(res, 200, deps.gates.open(run)));
  }
  if (path === "/api/tokens") {
    // Tokens is per-run: `?run=<id>` selects the run; absent it, there is no series (an empty one). The
    // source may be absent — `TokenReader` degrades to a clean empty `TokenSeries` (plan §7.3).
    return guardGet(method, res, () =>
      sendJson(res, 200, run !== undefined ? deps.tokens.series(run) : { timestamps: [], tokens: [] }),
    );
  }
  if (path === "/api/memory") {
    // Read-only browse/search across both mem roots. `?q=<text>` filters; absent it, the full browse.
    const q = url.searchParams.get("q");
    return guardGet(method, res, () =>
      sendJson(res, 200, q !== null && q.length > 0 ? deps.memory.search(q) : deps.memory.list()),
    );
  }

  const review = matchWorkReview(path);
  if (review !== null) {
    // One doc's on-disk review comments (the comment-rail hydrate, VISION §6). The gate key IS the docId
    // (the SAME key the `/comment` POST writes under). Reuses GateInbox's sidecar reader — no second
    // parser; an absent sidecar reads as `[]` (clean empty, never a 404 on a doc that simply has no
    // comments yet). A poisoned run/doc segment (the `runDir` guard throws) also reads as `[]`.
    return guardGet(method, res, () => {
      let comments: ReviewComment[];
      try {
        comments = deps.gates.commentsFor(review.runId, review.docId);
      } catch {
        comments = [];
      }
      sendJson(res, 200, comments);
    });
  }

  return false; // not a reader route — fall through to the write/static path.
}
