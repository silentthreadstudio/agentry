// read-routes — the Phase-1 REST read surface (ADR-001's `transport` edge). PINNED endpoint paths; the web
// api-client (task 10) consumes exactly these:
//   GET  /healthz                  → 200 {status:"ok"}           — the liveness probe (ADR-002's focus-or-start)
//   GET  /api/works                → RunSummary[]                 — the Works home list (AC2)
//   GET  /api/work/:id/graph       → GraphModel                  — one run's dependency/derivation graph
//   GET  /api/work/:id/doc/:docId  → DocModel                    — one doc the editor opens (the write-loop's read half)
//   GET  /api/context              → { run?: string }            — the SPA's run bootstrap (the host's run id)
// 404 on an unknown run/doc; 405 on a verb the path does not serve.
//
// This module is the thin HTTP-shape adapter over `WorkReader`: it parses the path, calls the reader, and
// serializes JSON. It holds no run state and does no fs/parse itself. The run for a path is the `:id`
// segment (task 9's `matchWorkGraph` resolution), which on a browser equals the host-router run (ADR-002).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkReader } from "../application/work-reader.js";
import type { RunContext } from "./host-router.js";
import { guardGet, sendJson } from "./http-kit.js";
import { matchWorkDoc, matchWorkGraph, resolveRun } from "./route-match.js";
import { toDocModel } from "./doc-model.js";

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
      // The `:id` segment may be a `workSlug` (task 003) or a full id — resolve it to the real run before
      // reading. An unresolvable label is an unknown run (404), the same outcome a stale id already gives.
      const runId = resolveRun(reader, graphId);
      const read = runId !== undefined ? reader.read(runId) : undefined;
      if (!read) return sendJson(res, 404, { error: "unknown_run" });
      sendJson(res, 200, read.graph);
    });
  }

  const doc = matchWorkDoc(path);
  if (doc !== null) {
    // The doc-fetch the write loop pairs with (unblocks task 16's DocDrawer): resolve the run (slug or
    // full id), then the doc by its id within the run's `docs` (ids mirror buildGraph's node ids — task
    // 8). 404s split so the client can tell an unknown run from an unknown doc within a known run.
    return guardGet(method, res, () => {
      const runId = resolveRun(reader, doc.runId);
      const read = runId !== undefined ? reader.read(runId) : undefined;
      if (!read) return sendJson(res, 404, { error: "unknown_run" });
      const found = read.docs.find((d) => d.id === doc.docId);
      if (!found) return sendJson(res, 404, { error: "unknown_doc" });
      sendJson(res, 200, toDocModel(found));
    });
  }

  return false; // no API route matched — let the http layer serve static (or the POST dispatcher, see http.ts).
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
