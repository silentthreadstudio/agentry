// write-routes — the Phase-3 POST write surface (ADR-001). The five POST handlers live in a SEPARATE async
// dispatcher because they consume the request BODY (a stream) — task 9's GET dispatcher is sync and
// body-free, left untouched. The http layer tries this dispatcher after the GET reads return false. Returns
// `true` when a POST route answered, `false` to fall through to static-serving.
//
//   POST /api/work/:id/comment   → { id }                      — append a review comment (AC5)
//   POST /api/work/:id/resolve   → { ok:true } | 404           — mark a comment resolved on disk (VISION §6)
//   POST /api/work/:id/status    → { ok:true } | 404           — set a task's lifecycle status (human override)
//   POST /api/work/:id/artifact  → DocModel | 409 | 404        — guarded artifact write (AC6/AC7)
//
// This module is the thin HTTP-shape adapter over `WriteService` (writes): it parses the path/body, calls
// the service, and serializes the typed outcome. It holds no run state and does no fs/parse itself. The two
// write invariants (lock + optimistic concurrency) are enforced wholly inside `WriteService` (ADR-006) —
// the client is never trusted here; the route only maps the outcome to an HTTP envelope. The run for a
// write is the path `:id` segment (the SAME resolution the GET routes use — task 9's `matchWorkGraph`).
import type { IncomingMessage, ServerResponse } from "node:http";
import { type DocModel, type WsMessage } from "@agentry/workbench-shared";
import { ReviewAnchor, ReviewDecision } from "@agentry/flow/domain/review";
import { FlowTaskStatus } from "@agentry/flow/domain/status";
import type { WorkReader } from "../application/work-reader.js";
import type { WriteService } from "../application/write-service.js";
import type { ArtifactTarget } from "../persistence/flow-writer.js";
import type { Transport } from "../domain/ports.js";
import { isRecord, readJsonBody, reject, sendJson } from "./http-kit.js";
import { matchWritePath, resolveRun } from "./route-match.js";
import { docIdOf, reloadDoc, targetFromDocId, taskNoFromTarget } from "./doc-model.js";

// The write-side dependencies the POST handlers need, threaded by the composition root alongside the
// `WorkReader` task 9 already injects. `WriteService` enforces the invariants; `Transport` fans the
// success message out to the run's ws subscribers (AC7).
export interface WriteDeps {
  reader: WorkReader;
  writeService: WriteService;
  transport: Transport;
}

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

  switch (write.kind) {
    case "comment":
      return handleComment(res, deps, runId, body);
    case "resolve":
      return handleResolve(res, deps, runId, body);
    case "status":
      return handleStatus(res, deps, runId, body);
    case "artifact":
      return handleArtifact(res, deps, runId, body);
    default: {
      const _exhaustive: never = write.kind;
      return _exhaustive;
    }
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

  // Optional reply lane: a human follow-up nests under `replyTo` with `origin:"human"`. Both are validated
  // loosely (a non-string replyTo / an out-of-vocab origin is ignored, never a write of a bad shape).
  const replyTo = typeof body.replyTo === "string" && body.replyTo.length > 0 ? body.replyTo : undefined;
  const origin = body.origin === "human" || body.origin === "agent" ? body.origin : undefined;

  const result = deps.writeService.addComment({
    run: runId,
    gate,
    anchor: anchor.data,
    decision: decision.data,
    body: bodyText,
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(origin !== undefined ? { origin } : {}),
  });
  // A comment changed the gate sidecar — nudge the run's watchers (the doc-level projection rides the
  // file-changed loop in index.ts; here we only confirm the write landed).
  deps.transport.push(runId, { type: "file-changed", path: `.review/${gate}.annotations.json` });
  sendJson(res, 200, result);
  return true;
}

// POST /api/work/:id/resolve → mark a comment resolved on disk by id (the rail's Resolve action,
// persisted so it survives reload — VISION §6). Body { gate, commentId }. A missing id is 404
// (unknown_comment); a successful flip pushes the same file-changed nudge the comment POST does.
function handleResolve(res: ServerResponse, deps: WriteDeps, runId: string, body: unknown): boolean {
  if (!isRecord(body)) return reject(res, 400, "invalid_body");
  const gate = body.gate;
  const commentId = body.commentId;
  if (typeof gate !== "string" || gate.length === 0) return reject(res, 400, "missing_gate");
  if (typeof commentId !== "string" || commentId.length === 0) {
    return reject(res, 400, "missing_comment_id");
  }
  const result = deps.writeService.resolveComment({ run: runId, gate, commentId });
  if (!result.ok) return reject(res, 404, "unknown_comment");
  deps.transport.push(runId, { type: "file-changed", path: `.review/${gate}.annotations.json` });
  sendJson(res, 200, { ok: true });
  return true;
}

// POST /api/work/:id/status → set a task's lifecycle status (the human override — cleanup note 3). Body
// { target: "task-<NNN>", status }. Validates the status against FLOW's closed union; a non-task target or
// an out-of-vocab status is a 400, an absent task file a 404. On success, nudges watchers so the navigator
// dots + graph re-tint (the client refetches the graph on any ws message).
function handleStatus(res: ServerResponse, deps: WriteDeps, runId: string, body: unknown): boolean {
  if (!isRecord(body)) return reject(res, 400, "invalid_body");
  const taskNo = taskNoFromTarget(body); // reuse: accepts `target: "task-<NNN>"`
  if (taskNo === null) return reject(res, 400, "not_a_task");
  const status = FlowTaskStatus.safeParse(body.status);
  if (!status.success) return reject(res, 400, "invalid_status");

  const outcome = deps.writeService.setStatus({ run: runId, taskNo, status: status.data });
  if (!outcome.ok) return reject(res, 404, "not_found");
  deps.transport.push(runId, { type: "file-changed", path: `tasks/${taskNo}` });
  sendJson(res, 200, { ok: true });
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
    const doc = reloadDoc(deps.reader, runId, target);
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

