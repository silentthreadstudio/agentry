// routes — the Phase-1 REST surface (ADR-001's `transport` edge). PINNED endpoint paths; the web
// api-client (task 10) consumes exactly these:
//   GET /healthz                 → 200 {status:"ok"}            — the liveness probe (ADR-002's focus-or-start)
//   GET /api/works               → RunSummary[]                  — the Works home list (AC2)
//   GET /api/work/:id/graph      → GraphModel                    — one run's dependency/derivation graph
//   GET /api/context             → { run?: string }              — the SPA's run bootstrap (the host's run id)
// 404 on an unknown run; 405 on a non-GET to a known path. The write endpoints (/comment,/artifact,
// /takeover) are Phase 3 — deliberately absent here.
//
// This module is the thin HTTP-shape adapter over `WorkReader` (the application service): it parses the
// path, calls the reader, and serializes JSON. It holds no run state and does no fs/parse itself.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkReader } from "../application/work-reader.js";
import type { RunContext } from "./host-router.js";

// `true` when this request was answered by a route, `false` when no API/healthz route matched (so the
// http layer falls through to static-serving the SPA). Keeps the dispatch a single, ordered decision.
export function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  reader: WorkReader,
  context: RunContext,
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/healthz") return guardGet(method, res, () => sendJson(res, 200, { status: "ok" }));

  if (path === "/api/works") {
    return guardGet(method, res, () => sendJson(res, 200, listWorks(reader)));
  }

  if (path === "/api/context") {
    // The run-id bootstrap: which run (if any) this host belongs to (host-router context). The SPA reads
    // it to open straight into a run; bare-home hosts get `{}` (no run).
    return guardGet(method, res, () =>
      sendJson(res, 200, context.run ? { run: context.run } : {}),
    );
  }

  const graphId = matchWorkGraph(path);
  if (graphId !== null) {
    return guardGet(method, res, () => {
      const read = reader.read(graphId);
      if (!read) return sendJson(res, 404, { error: "unknown_run" });
      sendJson(res, 200, read.graph);
    });
  }

  return false; // no API route matched — let the http layer serve static.
}

// The Works list: one RunSummary per run, derived from the SAME `read` the graph route uses (so the list
// row and the opened run never disagree). A run that vanishes between `listRuns` and `read` (a race with
// a deletion) is simply dropped from the list rather than 500-ing the whole page.
function listWorks(reader: WorkReader): unknown[] {
  const summaries = [];
  for (const runId of reader.listRuns()) {
    const read = reader.read(runId);
    if (read) summaries.push(read.summary);
  }
  return summaries;
}

// Match `/api/work/:id/graph` → the (still-encoded) run id, or null. The id segment is `decodeURIComponent`d
// so a percent-encoded run id round-trips; the host-router/WorkReader's `assertSafeSegment` is the guard,
// not this matcher.
function matchWorkGraph(path: string): string | null {
  const m = /^\/api\/work\/([^/]+)\/graph$/.exec(path);
  if (!m || m[1] === undefined) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null; // malformed percent-encoding — no match (falls through to 404 via no route)
  }
}

// Only GET is served on the Phase-1 read surface; a write verb to a known read path is 405, not a
// silent 404 (the write endpoints arrive in Phase 3). Returns true — the request was handled either way.
function guardGet(method: string, res: ServerResponse, run: () => void): boolean {
  if (method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  run();
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
