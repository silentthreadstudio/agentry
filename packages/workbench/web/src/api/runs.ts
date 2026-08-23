// POST /api/runs → start NEW work in this project. The server reuses FLOW's `run_start`, so a run
// created here is indistinguishable from one a session minted: same id shape, same `.agentry/work/<run>/`
// layout, same `spec.md` scaffold. The conducting session picks it up from the files.
import { ApiError, apiPath } from "./http.js";

export async function startRun(goal: string, signal?: AbortSignal): Promise<{ run: string }> {
  const res = await fetch(apiPath("/api/runs"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ goal }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new ApiError(`/api/runs → ${res.status} ${res.statusText}`, res.status);
  return (await res.json()) as { run: string };
}

/** Put a run's work back on the shelf: tasks to `todo`, its backlog item back to `ready`.
 *
 *  RESET, NOT CANCEL (doc 18 Q2). Nothing is deleted and no agent is stopped — the server does not kill
 *  processes, and a board drag must never be able to. */
export async function resetRun(run: string): Promise<{ ok: boolean; tasks: number }> {
  const res = await fetch(apiPath(`/api/work/${encodeURIComponent(run)}/reset`), {
    method: "POST",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new ApiError(`reset ${run} → ${res.status} ${res.statusText}`, res.status);
  return (await res.json()) as { ok: boolean; tasks: number };
}
