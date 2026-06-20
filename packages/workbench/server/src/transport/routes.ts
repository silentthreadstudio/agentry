// routes — the REST surface (ADR-001's `transport` edge). PINNED endpoint paths; the web api-client
// (task 10) consumes exactly these:
//   GET  /healthz                  → 200 {status:"ok"}           — the liveness probe (ADR-002's focus-or-start)
//   GET  /api/works                → RunSummary[]                 — the Works home list (AC2)
//   GET  /api/work/:id/graph       → GraphModel                  — one run's dependency/derivation graph
//   GET  /api/work/:id/doc/:docId  → DocModel                    — one doc the editor opens (the write-loop's read half)
//   GET  /api/context              → { run?: string }            — the SPA's run bootstrap (the host's run id)
//   POST /api/work/:id/comment     → { id }                      — append a review comment (AC5)
//   POST /api/work/:id/artifact    → DocModel | 409 | 404        — guarded artifact write (AC6/AC7); body
//                                                                   `{ target:docId, baseVersion, newBody }`
//                                                                   (adr-* → 409 read_only)
//   POST /api/work/:id/takeover    → { ok:true } | 404           — flip the edit lock (AC4); body
//                                                                   `{ target:"task-<NNN>", by? }` (by → "human")
// 404 on an unknown run/doc; 405 on a verb the path does not serve.
//
// This module is the thin HTTP-shape adapter over `WorkReader` (reads) and `WriteService` (writes): it
// parses the path/body, calls the service, and serializes JSON. It holds no run state and does no
// fs/parse itself. The two write invariants (lock + optimistic concurrency) are enforced wholly inside
// `WriteService` (ADR-006) — the client is never trusted here; the route only maps the typed outcome to
// an HTTP envelope. The run for a write is the path `:id` segment (the SAME resolution the GET routes
// use — task 9's `matchWorkGraph`), which on a browser equals the host-router run (ADR-002): the SPA
// only ever issues a path whose id is its own `<id>.localhost` host.
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveSlug, type DocModel, type WsMessage } from "@agentry/workbench-shared";
import { ReviewAnchor, ReviewDecision, type ReviewComment } from "@agentry/flow/domain/review";
import { computeVersion } from "@agentry/flow/domain/version";
import type { WorkReader } from "../application/work-reader.js";
import type { WriteService } from "../application/write-service.js";
import type { EventStore } from "../application/event-store.js";
import type { GateInbox } from "../application/gate-inbox.js";
import type { TokenReader } from "../application/token-reader.js";
import type { MemReader } from "../persistence/mem-reader.js";
import type { ArtifactTarget } from "../persistence/flow-writer.js";
import type { PermissionWatcher } from "../persistence/permission-watcher.js";
import { writeVerdict, type PermissionBehavior } from "../persistence/permission-writer.js";
import type { Transport } from "../domain/ports.js";
import type { RunContext } from "./host-router.js";

// The write-side dependencies the POST handlers need, threaded by the composition root alongside the
// `WorkReader` task 9 already injects. `WriteService` enforces the invariants; `Transport` fans the
// success message out to the run's ws subscribers (AC7).
export interface WriteDeps {
  reader: WorkReader;
  writeService: WriteService;
  transport: Transport;
}

// The Phase-4 read-aggregation services the five reader GET handlers fold (event-store/gate-inbox/
// token-reader/mem-reader). Threaded by the composition root alongside the `WorkReader`, the same DI
// pattern task 9 uses. These services are PURE of HTTP (ADR-001) — the handlers below are thin adapters
// that call them and serialize JSON, holding no run state of their own.
export interface ReaderDeps {
  events: EventStore;
  gates: GateInbox;
  tokens: TokenReader;
  memory: MemReader;
}

// The permission-relay surface (Phase 3b) — the project-global approvals endpoints. `watcher.current()`
// seeds the GET snapshot; `projectRoot` is where the verdict file is written (the SAME dir FLOW's relay
// watches). NOT run-scoped — these are session/project-level (served on the base host too).
export interface PermissionDeps {
  watcher: Pick<PermissionWatcher, "current">;
  projectRoot: string;
}

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

// ── Reader surface (Phase 4) ─────────────────────────────────────────────────────────────────────────
// The five aggregation reads behind the Activity / Agents / Gates / Tokens / Memory pages. ADDITIVE to the
// Phase-1 GET surface above — a SEPARATE dispatcher so task 9's pinned reads stay untouched; the http
// layer tries it after `handleApiRequest` returns false. All five are GET-only (a write verb is 405, never
// a silent fall-through). Host-scoped where it matters: `/api/events`, `/api/gates`, `/api/tokens` accept
// `?run=<id>` to filter to one run; absent the param they fold across every run (the cross-run view).
//
//   GET /api/events[?run=<id>]  → EventView[]   — the folded timeline (one fold powers Activity + Agents)
//   GET /api/agents[?run=<id>]  → AgentView[]   — the agent roster across runs (or one run)
//   GET /api/gates[?run=<id>]   → OpenGateItem[] — the open waiting-on-you gate items
//   GET /api/tokens?run=<id>    → TokenSeries   — the per-day token series for one run (empty if absent)
//   GET /api/memory[?q=<text>]  → MemReadRecord[] — read-only browse/search over both mem roots
//   GET /api/work/:id/review/:docId → ReviewComment[] — one doc's on-disk review comments (gate == docId)
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

// The `?run=<id>` query param decoded to a run id, or undefined when absent/empty. The URL layer already
// percent-decodes the value; the traversal safety is the store's `runDir`/`assertSafeSegment` guard.
function runParam(url: URL): string | undefined {
  const run = url.searchParams.get("run");
  return run !== null && run.length > 0 ? run : undefined;
}

// ── Write surface (Phase 3) ──────────────────────────────────────────────────────────────────────────
// The three POST handlers live in a SEPARATE async dispatcher because they consume the request BODY (a
// stream) — task 9's GET dispatcher above is sync and body-free, and is left untouched. The http layer
// tries this dispatcher after `handleApiRequest` returns false (no GET route matched). Returns `true`
// when a POST route answered, `false` to fall through to static-serving.
export async function handlePostRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WriteDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  const write = matchWritePath(path);
  if (write === null) return false; // not a write path — let the http layer fall through to static.
  if (method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  // The `:id` segment may be a `workSlug` (task 003) or the full id — resolve it to the real run so the
  // write boundary (lock/version + the fresh-doc re-read) operates on the same id the GET routes use. An
  // unresolvable label is an unknown run → 404, never a write against a non-existent run.
  const runId = resolveRun(deps.reader, write.runId);
  if (runId === undefined) {
    sendJson(res, 404, { error: "unknown_run" });
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return true;
  }

  if (write.kind === "comment") return handleComment(res, deps, runId, body);
  if (write.kind === "artifact") return handleArtifact(res, deps, runId, body);
  return handleTakeover(res, deps, runId, body);
}

// ── Permission relay surface (Phase 3b) ───────────────────────────────────────────────────────────────
// The project-global approvals endpoints (channels.md §"Relay permission prompts"). A SEPARATE dispatcher
// (additive — task 9/Phase-3/Phase-4 dispatchers untouched), tried after the run-scoped ones. These are
// NOT run-scoped: permissions are session/project-level, so they answer under every host (the base host
// included) and ignore the host's run context.
//
//   GET  /api/permissions              → PermissionRequest[]   — the pending approval prompts (the banner seed)
//   POST /api/permissions/:request_id  → { ok:true } | 400     — write the verdict file; body { behavior }
//
// POST consumes the body, so the dispatcher is async (mirrors handlePostRequest). Returns `true` when a
// permission route answered, `false` to fall through.
export async function handlePermissionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PermissionDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/api/permissions") {
    return guardGet(method, res, () => sendJson(res, 200, deps.watcher.current()));
  }

  const requestId = matchPermissionVerdict(path);
  if (requestId === null) return false; // not a permission route — fall through.
  if (method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return true;
  }
  return handleVerdict(res, deps, requestId, body);
}

// POST /api/permissions/:id → validate the behavior, write `<id>.verdict.json` (FLOW reads it, emits the
// verdict to Claude Code, and deletes both files — the request-file unlink is what drops the banner). The
// id traversal-safety is `assertSafeSegment` inside `writeVerdict`: a poisoned id throws → 400, never a
// write outside the dir. No ws push here — the watcher's unlink event drives the banner clear (one path).
function handleVerdict(
  res: ServerResponse,
  deps: PermissionDeps,
  requestId: string,
  body: unknown,
): boolean {
  if (!isRecord(body)) return reject(res, 400, "invalid_body");
  const behavior = body.behavior;
  if (behavior !== "allow" && behavior !== "deny") return reject(res, 400, "invalid_behavior");
  try {
    writeVerdict(deps.projectRoot, requestId, behavior as PermissionBehavior);
  } catch {
    // The only throw is `assertSafeSegment` on a poisoned id — a malformed request, never a 500.
    return reject(res, 400, "invalid_request_id");
  }
  sendJson(res, 200, { ok: true });
  return true;
}

// Match `/api/permissions/:request_id` → the decoded id, or null. The id is `decodeURIComponent`d so a
// percent-encoded value round-trips; the traversal safety is `assertSafeSegment` (in `writeVerdict`), not
// this matcher.
function matchPermissionVerdict(path: string): string | null {
  const m = /^\/api\/permissions\/([^/]+)$/.exec(path);
  if (!m || m[1] === undefined) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null; // malformed percent-encoding — no match
  }
}

// POST /api/work/:id/comment → build the 3-way anchor + decision from the body, append via WriteService
// (always allowed, lock or not — VISION §5), push a ws notification, return the minted `{ id }`. The
// anchor/decision are PARSED through FLOW's zod schemas (the client is never trusted — ADR-006); a
// malformed body is a 400, never a partial write.
function handleComment(res: ServerResponse, deps: WriteDeps, runId: string, body: unknown): boolean {
  if (!isRecord(body)) return reject(res, 400, "invalid_body");
  const gate = body.gate;
  const bodyText = body.body;
  if (typeof gate !== "string" || gate.length === 0) return reject(res, 400, "missing_gate");
  if (typeof bodyText !== "string") return reject(res, 400, "missing_body");

  // The 3-way anchor the web selection sends (originalText/headingAnchor/startLine), validated by FLOW.
  const anchor = ReviewAnchor.safeParse(body.anchor);
  if (!anchor.success) return reject(res, 400, "invalid_anchor");
  const decision = ReviewDecision.safeParse(body.decision);
  if (!decision.success) return reject(res, 400, "invalid_decision");

  const result = deps.writeService.addComment({
    run: runId,
    gate,
    anchor: anchor.data,
    decision: decision.data,
    body: bodyText,
  });
  // A comment changed the gate sidecar — nudge the run's watchers (the doc-level projection rides the
  // file-changed loop in index.ts; here we only confirm the write landed).
  deps.transport.push(runId, { type: "file-changed", path: `.review/${gate}.annotations.json` });
  sendJson(res, 200, result);
  return true;
}

// POST /api/work/:id/artifact → the guarded write (AC6/AC7). The route is a thin adapter: parse the
// body, call WriteService, map the typed outcome. On success it re-reads the fresh DocModel, pushes a
// `doc-updated` WsMessage carrying it (AC7), and returns it. Rejections map: locked→409 (+lockedBy),
// stale→409 (+currentVersion, the optimistic-concurrency reject AC6), not-found→404.
function handleArtifact(res: ServerResponse, deps: WriteDeps, runId: string, body: unknown): boolean {
  if (!isRecord(body)) return reject(res, 400, "invalid_body");
  // The web client sends `target` as the `docId` STRING (the SAME id GET /doc/:docId returns):
  // "spec"/"plan"/"task-<NNN>" are editable; "adr-*" is read-only in V1 (a decision record) and is
  // rejected with `read_only`; anything else is an unknown target (400). The mapping is pure adapter —
  // the WriteService below is unchanged (task 15's pinned logic).
  const mapped = targetFromDocId(body.target);
  if (mapped === "read_only") return reject(res, 409, "read_only");
  if (mapped === null) return reject(res, 400, "invalid_target");
  const target = mapped;
  const baseVersion = body.baseVersion;
  const newBody = body.newBody;
  if (typeof baseVersion !== "string") return reject(res, 400, "missing_baseVersion");
  if (typeof newBody !== "string") return reject(res, 400, "missing_newBody");

  const outcome = deps.writeService.writeArtifact({ run: runId, target, baseVersion, newBody });
  if (outcome.ok) {
    const doc = reloadDoc(deps, runId, target);
    if (doc) {
      const message: WsMessage = { type: "doc-updated", docId: docIdOf(target), doc };
      deps.transport.push(runId, message);
      sendJson(res, 200, doc);
    } else {
      // Wrote, but the run/doc vanished on re-read (a concurrent delete) — still report the new version.
      sendJson(res, 200, { version: outcome.version });
    }
    return true;
  }
  if (outcome.reason === "locked") return reject(res, 409, "locked", { lockedBy: outcome.lockedBy });
  if (outcome.reason === "stale") {
    return reject(res, 409, "stale", { currentVersion: outcome.currentVersion });
  }
  return reject(res, 404, "not_found"); // not-found
}

// POST /api/work/:id/takeover → flip the edit lock (AC4). The server performs the lock transition (the
// human claiming the edit); ok→{ok:true}+push, not-found→404.
function handleTakeover(res: ServerResponse, deps: WriteDeps, runId: string, body: unknown): boolean {
  if (!isRecord(body)) return reject(res, 400, "invalid_body");
  // Takeover applies to TASK docs only (only tasks carry status/lockedBy). The web sends the `docId`
  // STRING as `target` ("task-<NNN>"); a legacy `{ taskNo }` is still accepted. Anything that is not a
  // task doc (spec/plan/adr-*) is rejected — those carry no lock to take. `by` defaults to "human"
  // (the generic takeover holder — single-user local workbench).
  const taskNo = taskNoFromTakeover(body);
  if (taskNo === null) return reject(res, 400, "invalid_target");
  const rawBy = body.by;
  const by = typeof rawBy === "string" && rawBy.length > 0 ? rawBy : "human";

  const outcome = deps.writeService.takeOver({ run: runId, taskNo, by });
  if (!outcome.ok) return reject(res, 404, "not_found");

  // The lock flip is a frontmatter write — push the fresh doc so the editor reconciles the new lock state.
  const target: ArtifactTarget = { taskNo };
  const doc = reloadDoc(deps, runId, target);
  if (doc) deps.transport.push(runId, { type: "doc-updated", docId: docIdOf(target), doc });
  sendJson(res, 200, { ok: true });
  return true;
}

// Re-read one doc as a fresh DocModel after a write (so the ws push + the artifact response carry the
// re-stamped version + current lock). Returns undefined when the run or doc no longer resolves.
function reloadDoc(deps: WriteDeps, runId: string, target: ArtifactTarget): DocModel | undefined {
  const read = deps.reader.read(runId);
  if (!read) return undefined;
  const found = read.docs.find((d) => d.id === docIdOf(target));
  return found ? toDocModel(found) : undefined;
}

// The doc id for an artifact target — the SAME keys the reader's `docs` use (buildGraph node ids): a
// run-root artifact is its `kind` ("spec"/"plan"); a task is `task-<no>`.
function docIdOf(target: ArtifactTarget): string {
  return "kind" in target ? target.kind : `task-${target.taskNo}`;
}

// Project a reader doc (frontmatter+body) into the transport DocModel. The `version` is the optimistic-
// concurrency token the client echoes back as `baseVersion` — it MUST equal what `WriteService` checks
// against on save, which is FLOW's `computeVersion(body, frontmatter-sans-version)` (ADR-006), NOT the
// frontmatter's stamped `version` field (those can drift on a hand-edited file — a stale stamp would
// false-reject every save). So we recompute it here over the same (body, frontmatter-sans-version)
// inputs the write boundary uses, reusing FLOW's shared hash (ADR-005). The lock is derived from FLOW's
// `status:in-progress` + `lockedBy` — null when the doc is free.
function toDocModel(doc: { frontmatter: Record<string, unknown>; body: string }): DocModel {
  const { version: _stamped, ...sansVersion } = doc.frontmatter;
  return {
    frontmatter: doc.frontmatter,
    body: doc.body,
    version: computeVersion(doc.body, sansVersion),
    lock: lockOf(doc.frontmatter),
  };
}

// Derive the edit lock the editor shows: a task whose `status === "in-progress"` is locked by `lockedBy`
// (or its assignee). Run-root artifacts carry no task lifecycle → never locked. Mirrors the WriteService
// lock check (ADR-006), read-only here.
function lockOf(frontmatter: Record<string, unknown>): DocModel["lock"] {
  if (frontmatter.status !== "in-progress") return null;
  const by = frontmatter.lockedBy;
  const assignee = frontmatter.assignee;
  const holder =
    typeof by === "string" && by.length > 0
      ? by
      : typeof assignee === "string" && assignee.length > 0
        ? assignee
        : "an agent";
  const acquiredAt = typeof frontmatter.updatedAt === "string" ? frontmatter.updatedAt : "";
  return { by: holder, acquiredAt };
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

// Resolve a `:id` path segment (or a `?run=` value) to a FULL run id. The segment may be a short
// `workSlug` subdomain label (task 003) — the SPA, running at `<workSlug>.localhost`, issues paths whose
// id IS its host label — or the full run id itself (back-compat / terse ids). `resolveSlug` (shared)
// scans the known runs: an exact id match OR a `workSlug` match wins; an unresolvable label is undefined
// (the caller turns that into a 404, never a 500). The traversal safety stays the reader's
// `assertSafeSegment` guard — `resolveSlug` only ever returns an id that is actually present.
function resolveRun(reader: WorkReader, label: string): string | undefined {
  return resolveSlug(label, reader.listRuns());
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

// Match `/api/work/:id/doc/:docId` → the decoded run + doc ids, or null. Same decode discipline as
// `matchWorkGraph`; the run/doc safety is the host-router/reader guard, not this matcher.
function matchWorkDoc(path: string): { runId: string; docId: string } | null {
  const m = /^\/api\/work\/([^/]+)\/doc\/([^/]+)$/.exec(path);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  try {
    return { runId: decodeURIComponent(m[1]), docId: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

// Match `/api/work/:id/review/:docId` → the decoded run + doc ids, or null. The doc id IS the gate key
// (the comment loop's gate == docId). Same decode discipline as `matchWorkDoc`; the run-segment safety is
// the store's `runDir`/`assertSafeSegment` guard, not this matcher.
function matchWorkReview(path: string): { runId: string; docId: string } | null {
  const m = /^\/api\/work\/([^/]+)\/review\/([^/]+)$/.exec(path);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  try {
    return { runId: decodeURIComponent(m[1]), docId: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

// Match a write path `/api/work/:id/{comment|artifact|takeover}` → its kind + the decoded run id, or
// null. The matcher only recognizes the shape; the verb gate + body parse happen in the dispatcher.
function matchWritePath(
  path: string,
): { kind: "comment" | "artifact" | "takeover"; runId: string } | null {
  const m = /^\/api\/work\/([^/]+)\/(comment|artifact|takeover)$/.exec(path);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  try {
    return { kind: m[2] as "comment" | "artifact" | "takeover", runId: decodeURIComponent(m[1]) };
  } catch {
    return null;
  }
}

// Map the `docId` STRING the web client sends to the WriteService's `ArtifactTarget`, the inverse of
// `docIdOf`. The docId is the SAME id GET /doc/:docId returns (mirrors buildGraph's node ids):
//   "spec"        → { kind: "spec" }
//   "plan"        → { kind: "plan" }
//   "task-<NNN>"  → { taskNo: "<NNN>" }
//   "adr-*"       → "read_only"  (ADRs are decision records — read-only in V1, the route rejects writes)
//   anything else → null          (unknown target → 400)
// The client is never trusted (ADR-006): an empty/missing/non-string target is `null`, and a `task-`
// id with no number is `null` (not a write target).
function targetFromDocId(raw: unknown): ArtifactTarget | "read_only" | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw === "spec" || raw === "plan") return { kind: raw };
  if (raw.startsWith("adr-")) return "read_only";
  if (raw.startsWith("task-")) {
    const taskNo = raw.slice("task-".length);
    return taskNo.length > 0 ? { taskNo } : null;
  }
  return null;
}

// Derive the task number for a takeover from the request body — accept the `docId` form
// (`target: "task-<NNN>"`, the shape the web sends) or a legacy `{ taskNo }`. Only TASK docs are
// take-overable (they alone carry status/lockedBy); a non-task `target` (spec/plan/adr-*) yields null.
function taskNoFromTakeover(body: Record<string, unknown>): string | null {
  const target = body.target;
  if (typeof target === "string" && target.startsWith("task-")) {
    const taskNo = target.slice("task-".length);
    return taskNo.length > 0 ? taskNo : null;
  }
  const taskNo = body.taskNo;
  return typeof taskNo === "string" && taskNo.length > 0 ? taskNo : null;
}

// Read + JSON-parse the request body, capping it so a hostile client can't exhaust memory (the local
// write payloads are small markdown bodies). An empty body parses to `{}` (a bodyless POST is a 400 at
// the field checks, not here). Rejects (throws) on overflow or malformed JSON — the dispatcher maps it
// to 400.
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB — generous for a doc body, bounded against abuse.
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        rejectPromise(new Error("invalid_json"));
      }
    });
    req.on("error", rejectPromise);
  });
}

// Only GET is served on the read surface; a write verb to a known read path is 405, not a silent 404.
// Returns true — the request was handled either way.
function guardGet(method: string, res: ServerResponse, run: () => void): boolean {
  if (method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  run();
  return true;
}

// A plain-object guard for untrusted request bodies (rejects null/array/primitive).
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Send an `{ error }` envelope (+ optional extra fields like `lockedBy`/`currentVersion`) and return
// true — the request was handled. The single error-shape helper for the write surface.
function reject(
  res: ServerResponse,
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): boolean {
  sendJson(res, status, { error, ...extra });
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
