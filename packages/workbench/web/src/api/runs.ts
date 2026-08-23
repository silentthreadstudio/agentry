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
