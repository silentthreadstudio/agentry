// GET /api/context → the run-id bootstrap: which run (if any) the current *.localhost host belongs to.
// Bare localhost → no run (Works home); <id>.localhost → that run id. A `<meta name="agentry-run">` tag
// (if the server injects one) wins to avoid the round-trip.
import { getJson } from "./http.js";

export interface AppContext {
  run?: string;
}

export async function fetchContext(signal?: AbortSignal): Promise<AppContext> {
  const meta = document.querySelector('meta[name="agentry-run"]')?.getAttribute("content");
  if (meta) return { run: meta };
  return getJson<AppContext>("/api/context", signal);
}
