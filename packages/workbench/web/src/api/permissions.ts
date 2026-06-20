// The project-global approvals relay (Phase 3b) — NOT run-scoped (permissions are session/project-level,
// served on every host). GET /api/permissions seeds the banner; POST /api/permissions/:id writes the
// verdict file FLOW relays to Claude Code. First answer wins; the banner clears off the ws unlink event.
import type { PermissionRequest } from "@agentry/workbench-shared";
import { ApiError, getJson } from "./http.js";

export function fetchPermissions(signal?: AbortSignal): Promise<PermissionRequest[]> {
  return getJson<PermissionRequest[]>("/api/permissions", signal);
}

export async function postVerdict(requestId: string, behavior: "allow" | "deny"): Promise<void> {
  const res = await fetch(`/api/permissions/${encodeURIComponent(requestId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ behavior }),
  });
  if (!res.ok) {
    throw new ApiError(`POST /api/permissions/${requestId} → ${res.status} ${res.statusText}`, res.status);
  }
}
