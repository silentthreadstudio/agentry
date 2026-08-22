// The HTTP core the per-resource API modules share: the typed `getJson` fetch wrapper, the `ApiError`
// it throws on a non-2xx, the `runQuery` helper for the optional `?run=` scoping, and `apiPath` — the
// project seam. Every request is relative (same-origin).
//
// PROJECT SELECTION. One server serves several project roots, so every request must say which one it
// means. The selection lives in `sessionStorage` (per TAB — two tabs can watch two projects at once) and
// `?project=<slug>` in the page URL seeds it, so a deep link still works. `apiPath` stamps it onto every
// request; a raw `fetch` that skips `apiPath` would silently read the DEFAULT project instead.
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiPath(path), {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new ApiError(`${path} → ${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

// The optional run-scoping query: `?run=<id>` when a runId is given, else "" (the cross-run read).
export const runQuery = (runId?: string): string => (runId ? `?run=${encodeURIComponent(runId)}` : "");

const PROJECT_KEY = "agentry.workbench.project";

/** The project this tab is looking at: the page URL's `?project=` (which also seeds the tab) else the
 *  tab's stored selection else null (the server's default project). */
export function currentProject(): string | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("project");
    if (fromUrl !== null && fromUrl.length > 0) {
      window.sessionStorage.setItem(PROJECT_KEY, fromUrl);
      return fromUrl;
    }
    return window.sessionStorage.getItem(PROJECT_KEY);
  } catch {
    return null; // storage can throw (private mode, blocked site data) — fall back to the default project
  }
}

/** Point this tab at a project. The caller navigates afterwards; every later request carries it. */
export function selectProject(slug: string): void {
  try {
    window.sessionStorage.setItem(PROJECT_KEY, slug);
  } catch {
    /* storage unavailable — the `?project=` URL form still works */
  }
}

/** Stamp the tab's project onto an API path. EVERY request to the local server must go through this. */
export function apiPath(path: string): string {
  const project = currentProject();
  if (project === null) return path;
  return `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(project)}`;
}
