// The HTTP core the per-resource API modules share: the typed `getJson` fetch wrapper, the `ApiError`
// it throws on a non-2xx, and the `runQuery` helper for the optional `?run=` scoping. Every request is
// relative (same-origin) so it resolves behind any *.localhost host the local server is reached on. The
// resource modules (works/graph/events/…) import these; they never re-implement the fetch.
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
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
