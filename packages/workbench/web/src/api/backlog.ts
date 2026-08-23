// The project's backlog — durable intent that has not become a run yet (doc 18 §3.1).
//
// Note what is missing: there is no `claim` here, and there must not be. Minting a run from an item is a
// session's move, not the dashboard's — the Workbench has no model and must never appear to start work.
import type { BacklogItem } from "@agentry/workbench-shared";
import { ApiError, apiPath, getJson } from "./http.js";

export function fetchBacklog(status?: string, signal?: AbortSignal): Promise<{ items: BacklogItem[] }> {
  const q = status !== undefined ? `?status=${encodeURIComponent(status)}` : "";
  return getJson<{ items: BacklogItem[] }>(`/api/backlog${q}`, signal);
}

export async function createBacklogItem(input: {
  title: string;
  body?: string;
  kind?: string;
  ready?: boolean;
}): Promise<BacklogItem> {
  return post("/api/backlog", input);
}

export async function patchBacklogItem(id: string, patch: Record<string, unknown>): Promise<BacklogItem> {
  return post(`/api/backlog/${encodeURIComponent(id)}`, patch);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiPath(path), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(`${path} → ${res.status} ${res.statusText}`, res.status);
  return (await res.json()) as T;
}
