// permissions-store — the PURE pending-list logic behind the approvals banner (Phase 3b). The banner
// seeds from `GET /api/permissions` then folds the live ws messages (`permission-added` /
// `permission-removed`) into the list. That fold is extracted here so it's unit-testable without React or
// a socket: given the current list and a message, return the next list.
//
//   • added   → upsert by `request_id` (a re-emit of the same id replaces, never duplicates — chokidar
//               can fire add+change for one file; idempotent is the contract).
//   • removed → drop by id (FLOW deleted the request file: resolved in the terminal OR by a verdict we
//               wrote — either way the prompt is gone and the banner clears it).
//
// Insertion order is preserved (oldest first) so the banner stacks stably; an upsert keeps the item's
// original position (a status re-emit shouldn't reorder the stack under the user).
import type { PermissionRequest, WsMessage } from "@agentry/workbench-shared";

// Fold one ws message into the pending list. A non-permission message returns the list unchanged (the
// banner shares the one ws stream with the rest of the app). Returns the SAME reference when nothing
// changed, so React can skip a re-render.
export function applyPermissionMessage(
  pending: PermissionRequest[],
  msg: WsMessage,
): PermissionRequest[] {
  if (msg.type === "permission-added") return upsert(pending, msg.request);
  if (msg.type === "permission-removed") return remove(pending, msg.requestId);
  return pending;
}

// Insert a request, or replace it in place if its id is already present (dedup). Keeps original order.
function upsert(pending: PermissionRequest[], request: PermissionRequest): PermissionRequest[] {
  const i = pending.findIndex((p) => p.request_id === request.request_id);
  if (i === -1) return [...pending, request];
  const next = pending.slice();
  next[i] = request;
  return next;
}

// Drop the request with this id. Returns the same reference when the id isn't present (no-op, no
// re-render).
function remove(pending: PermissionRequest[], requestId: string): PermissionRequest[] {
  const i = pending.findIndex((p) => p.request_id === requestId);
  if (i === -1) return pending;
  return pending.filter((p) => p.request_id !== requestId);
}

// Merge a fresh server snapshot (a (re)fetch of `GET /api/permissions`) into the list, deduped by id.
// Used when the socket reconnects: the snapshot is authoritative for what's still pending, but we keep it
// id-deduped so an in-flight `added` that raced the fetch doesn't double up.
export function mergeSnapshot(snapshot: PermissionRequest[]): PermissionRequest[] {
  const seen = new Set<string>();
  const out: PermissionRequest[] = [];
  for (const r of snapshot) {
    if (seen.has(r.request_id)) continue;
    seen.add(r.request_id);
    out.push(r);
  }
  return out;
}
