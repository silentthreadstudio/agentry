// Run-scoped writes the board performs. Creating a run directly is NOT here: the board creates backlog
// ITEMS, and a run comes from a session claiming one (doc 18 §3.2). An endpoint that minted a run from
// the dashboard would be a second, competing way to start work with none of the claim path's meaning.
import { ApiError, apiPath } from "./http.js";

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
