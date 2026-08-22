// GET /api/context → the SPA's bootstrap. Two questions, one call: WHICH PROJECT is this server actually
// serving (the port is a global singleton but the root is per-process, so the UI must never hardcode a
// project name), and WHICH RUN is being addressed. Pass the `/work/<slug>` label to resolve it to a full
// run id; omit it on the Works home. A `<meta name="agentry-run">` tag (if the server injects one) still
// wins for the run, to avoid the round-trip.
import { getJson, runQuery } from "./http.js";

export interface AppContext {
  /** The basename of the served project root — what the sidebar labels this workspace. */
  project?: string;
  /** The absolute project root the server is reading `.agentry/` from. */
  root?: string;
  /** The full run id, when a run was addressed (by `?run=` label or the `*.localhost` alias). */
  run?: string;
}

export async function fetchContext(runLabel?: string, signal?: AbortSignal): Promise<AppContext> {
  const ctx = await getJson<AppContext>(`/api/context${runQuery(runLabel)}`, signal);
  if (ctx.run === undefined) {
    const meta = document.querySelector('meta[name="agentry-run"]')?.getAttribute("content");
    if (meta) return { ...ctx, run: meta };
  }
  return ctx;
}
