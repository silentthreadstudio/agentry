// permission-routes — the project-global approvals relay surface (Phase 3b, channels.md §"Relay permission
// prompts"). A SEPARATE dispatcher from the run-scoped read/reader/write routes: permissions are
// session/project-level, so these answer under EVERY host (the base host included) and ignore run context.
//
//   GET  /api/permissions              → PermissionRequest[]   — the pending approval prompts (banner seed)
//   POST /api/permissions/:request_id  → { ok:true } | 400     — write the verdict file; body { behavior }
//
// POST consumes the body, so the dispatcher is async (mirrors handlePostRequest). Returns `true` when a
// permission route answered, `false` to fall through to the next dispatcher / static serving.
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeVerdict, type PermissionBehavior } from "../persistence/permission-writer.js";
import type { PermissionWatcher } from "../persistence/permission-watcher.js";
import { matchPermissionVerdict } from "./route-match.js";
import { guardGet, isRecord, readJsonBody, reject, sendJson } from "./http-kit.js";

// `watcher.current()` seeds the GET snapshot; `projectRoot` is where the verdict file is written (the SAME
// dir FLOW's relay watches). NOT run-scoped — session/project-level (served on the base host too).
export interface PermissionDeps {
  watcher: Pick<PermissionWatcher, "current">;
  projectRoot: string;
}

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
